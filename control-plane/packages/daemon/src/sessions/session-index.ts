/**
 * Every OMP session ever run on this machine, not only the ones ompd
 * spawned: filesystem catalog (scanner.ts) plus decoded cwd (cwd-codec.ts)
 * plus verified liveness (liveness.ts) plus durable archive state (the
 * store), assembled into one queryable, sortable, groupable view.
 *
 * Rebuilt from the filesystem on every call. A session file can be appended
 * to or removed by the OMP TUI at any moment this daemon does not control,
 * so caching the assembled view itself would go stale under it; the only
 * thing cached across calls is the expensive part -- message counts, keyed
 * by mtime+size in the store -- which invalidates itself the instant a file
 * actually changes.
 */

import type { Store } from "@ompd/core";
import { TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type {
  AgentId,
  SessionCwdScope,
  SessionGroup,
  SessionLiveStatus,
  SessionQuery,
  SessionSortDir,
  SessionSortKey,
  SessionSummary,
} from "@ompd/core/contracts";
import { decodeSessionDirName, type DecodedCwd } from "./cwd-codec.ts";
import { listLiveClientPresences, runDaemonsRoot } from "./liveness.ts";
import {
  countMessages,
  MESSAGE_COUNT_SIZE_CEILING_BYTES,
  scanSessionFiles,
  type RawSessionFile,
} from "./scanner.ts";

export interface SessionIndexOptions {
  store: Store;
  sessionsRoot?: string;
  runDaemonsRoot?: string;
  homeDir?: string;
  tmpDir?: string;
}

const STATUS_RANK: Record<SessionLiveStatus, number> = {
  "live-ompd": 0,
  "live-tui": 1,
  dormant: 2,
  archived: 3,
};

export class SessionIndex {
  #store: Store;
  #sessionsRoot: string | undefined;
  #runDaemonsRoot: string | undefined;
  #homeDir: string | undefined;
  #tmpDir: string | undefined;
  /** Decoded cwd, keyed by flattened dir name: many sessions share one directory, so this decodes each name once per build instead of once per session. */
  #cwdCache = new Map<string, DecodedCwd>();

  constructor(opts: SessionIndexOptions) {
    this.#store = opts.store;
    this.#sessionsRoot = opts.sessionsRoot;
    this.#runDaemonsRoot = opts.runDaemonsRoot;
    this.#homeDir = opts.homeDir;
    this.#tmpDir = opts.tmpDir;
  }

  #decodeCwd(flattenedDir: string): DecodedCwd {
    const cached = this.#cwdCache.get(flattenedDir);
    if (cached) return cached;
    const decoded = decodeSessionDirName(flattenedDir, this.#homeDir, this.#tmpDir);
    this.#cwdCache.set(flattenedDir, decoded);
    return decoded;
  }

  /** The message count for one file: a cache hit when mtime+size still match, a fresh count (cached for next time) when they do not, or null without ever reading the file when it exceeds the size ceiling. */
  #messageCountFor(file: RawSessionFile): number | null {
    if (file.sizeBytes > MESSAGE_COUNT_SIZE_CEILING_BYTES) return null;
    const cached = this.#store.getSessionScanCache(file.id);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
      return cached.messageCount;
    }
    const count = countMessages(file.path);
    this.#store.setSessionScanCache(file.id, {
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
      messageCount: count,
    });
    return count;
  }

  /**
   * Build the full catalog fresh from disk, the client presence registry,
   * and ompd's own agent roster. Callers query/group/sort the returned array;
   * nothing about the assembled view itself is cached.
   */
  build(): SessionSummary[] {
    this.#cwdCache.clear();
    const files = scanSessionFiles(this.#sessionsRoot);
    const archived = this.#store.listArchivedSessionIds();
    const liveClients = listLiveClientPresences(this.#runDaemonsRoot ?? runDaemonsRoot());
    const liveClientBySessionId = new Map<string, (typeof liveClients)[number]>();
    for (const client of liveClients) {
      if (client.sessionId) liveClientBySessionId.set(client.sessionId, client);
    }
    // Only non-terminal agents count as "ompd currently holds this session";
    // a stopped or failed agent's session file is still on disk but the
    // process behind it is gone, which `dormant` already describes correctly.
    const liveAgentBySessionId = new Map<string, AgentId>();
    for (const agent of this.#store.listAgents()) {
      if (agent.acpSessionId && !TERMINAL_AGENT_STATES.includes(agent.state)) {
        liveAgentBySessionId.set(agent.acpSessionId, agent.id);
      }
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const decoded = this.#decodeCwd(file.flattenedDir);
      const isArchived = archived.has(file.id);
      const agentId = liveAgentBySessionId.get(file.id);
      const liveClient = liveClientBySessionId.get(file.id);

      let status: SessionLiveStatus;
      let pid: number | undefined;
      if (isArchived) {
        // An explicit archive is an operator decision; it outranks a stale
        // client-presence file nobody cleaned up.
        status = "archived";
      } else if (agentId !== undefined) {
        // A live process beats a disk read, and ompd's own supervised agent
        // row -- reconciled independently by the supervisor -- beats a bare
        // client-presence file for the same session.
        status = "live-ompd";
      } else if (liveClient) {
        status = "live-tui";
        pid = liveClient.pid;
      } else {
        status = "dormant";
      }

      const cwdScope: SessionCwdScope = decoded.status === "ok" ? decoded.scope : "unknown";
      summaries.push({
        id: file.id,
        cwd: decoded.status === "ok" ? decoded.cwd : null,
        cwdScope,
        ...(decoded.status === "unknown" ? { cwdDecodeReason: decoded.reason } : {}),
        flattenedDir: file.flattenedDir,
        title: file.title,
        createdAt: file.createdAt,
        lastActivityAt: new Date(file.mtimeMs).toISOString(),
        messageCount: this.#messageCountFor(file),
        byteSize: file.sizeBytes,
        status,
        archived: isArchived,
        ...(pid !== undefined ? { pid } : {}),
        ...(status === "live-ompd" && agentId !== undefined ? { agentId } : {}),
      });
    }
    return summaries;
  }

  /** Query, filter, and sort the catalog. Archived sessions are excluded unless `includeArchived` is set. */
  query(q: SessionQuery = {}): SessionSummary[] {
    let rows = this.build();
    if (!q.includeArchived) rows = rows.filter((r) => !r.archived);
    if (q.status && q.status.length > 0) {
      const wanted = q.status;
      rows = rows.filter((r) => wanted.includes(r.status));
    }
    if (q.cwd !== undefined) {
      const wantedCwd = q.cwd;
      rows = rows.filter((r) => r.cwd === wantedCwd || r.flattenedDir === wantedCwd);
    }
    return sortSessions(rows, q.sort ?? "lastActivity", q.sortDir ?? "desc");
  }

  /**
   * The same query, grouped by directory. Groups are ordered by their most
   * recent session's activity regardless of the within-group sort key the
   * caller asked for, so the busiest project surfaces first even when
   * sessions inside each group are sorted by, say, size.
   */
  grouped(q: SessionQuery = {}): SessionGroup[] {
    const rows = this.query(q);
    const groups = new Map<string, SessionGroup>();
    for (const row of rows) {
      const key = row.cwd ?? row.flattenedDir;
      let group = groups.get(key);
      if (!group) {
        group = { key, cwd: row.cwd, sessions: [] };
        groups.set(key, group);
      }
      group.sessions.push(row);
    }
    const out = [...groups.values()];
    out.sort((a, b) => {
      const aLatest = latestActivity(a.sessions);
      const bLatest = latestActivity(b.sessions);
      return bLatest.localeCompare(aLatest);
    });
    return out;
  }

  archive(sessionId: string): void {
    this.#store.archiveSession(sessionId);
  }

  unarchive(sessionId: string): void {
    this.#store.unarchiveSession(sessionId);
  }
}

function latestActivity(sessions: SessionSummary[]): string {
  let latest = "";
  for (const s of sessions) {
    if (s.lastActivityAt > latest) latest = s.lastActivityAt;
  }
  return latest;
}

function sortSessions(
  rows: SessionSummary[],
  key: SessionSortKey,
  dir: SessionSortDir,
): SessionSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (key) {
      case "status":
        return sign * (STATUS_RANK[a.status] - STATUS_RANK[b.status]);
      case "age":
        return sign * a.createdAt.localeCompare(b.createdAt);
      case "lastActivity":
        return sign * a.lastActivityAt.localeCompare(b.lastActivityAt);
      case "messageCount":
        // Null (uncounted, oversized) sorts as lowest so an unknown count
        // never silently outranks a real one regardless of direction.
        return sign * ((a.messageCount ?? -1) - (b.messageCount ?? -1));
      case "size":
        return sign * (a.byteSize - b.byteSize);
      default: {
        const exhaustive: never = key;
        throw new Error(`unhandled sort key ${String(exhaustive)}`);
      }
    }
  });
}
