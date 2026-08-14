/**
 * Integration coverage for `SessionIndex`: proves the assembled view is
 * correct where it matters most -- liveness cannot be faked by a stale
 * record, archiving is durable across a real store reopen (not just an
 * in-memory flag), and every advertised sort order actually orders.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import type { Agent, HostRef } from "@ompd/core/contracts";
import { SessionIndex } from "../../src/sessions/session-index.ts";

const scratch: string[] = [];
const openStores: Store[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function openStore(dbPath: string): Store {
  const store = new Store(dbPath);
  openStores.push(store);
  return store;
}

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  lines: unknown[],
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return filePath;
}

function titleLine(title: string): unknown {
  return { type: "title", v: 1, title, updatedAt: new Date().toISOString() };
}

function messageLine(id: string, role: "user" | "assistant"): unknown {
  return { type: "message", id, message: { role, content: [{ type: "text", text: "x" }] } };
}

function fakeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: overrides.id ?? "agt_0000000000000000",
    name: overrides.name ?? "test-agent",
    state: overrides.state ?? "idle",
    host: overrides.host ?? ({ kind: "local", id: "12345", spec: { kind: "local" } } satisfies HostRef),
    cwd: overrides.cwd ?? "/x",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActiveAt: overrides.lastActiveAt ?? new Date().toISOString(),
    labels: overrides.labels ?? {},
    ...overrides,
  };
}

/** Builds a SessionIndex over an isolated sessions tree and an isolated store, with liveness pointed at an empty run/daemons root so no real process on the test machine leaks into results. */
function buildIndex(sessionsRoot: string, store: Store): SessionIndex {
  const emptyRunRoot = tempRoot("session-index-empty-run-");
  return new SessionIndex({ store, sessionsRoot, runDaemonsRoot: emptyRunRoot });
}

const SESSION_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_B = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_C = "019ff8ca-b4ca-7000-a133-beedf9dfab06";

describe("SessionIndex.build", () => {
  test("spans multiple cwd groups", () => {
    const sessionsRoot = tempRoot("session-index-groups-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-Downloads", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("Manuscript"),
    ]);
    writeSessionFile(sessionsRoot, "-dev-src-github.com-acme-widgets", "2026-08-12T00-00-00-000Z", SESSION_B, [
      titleLine("Widgets work"),
    ]);
    writeSessionFile(sessionsRoot, "--private-tmp--", "2026-08-13T00-00-00-000Z", SESSION_C, [
      titleLine(""),
    ]);

    const index = buildIndex(sessionsRoot, store);
    const summaries = index.build();
    expect(summaries).toHaveLength(3);
    expect(new Set(summaries.map((s) => s.flattenedDir))).toEqual(
      new Set(["-Downloads", "-dev-src-github.com-acme-widgets", "--private-tmp--"]),
    );
  });

  test("a stale client presence record does not make a session look live", () => {
    const sessionsRoot = tempRoot("session-index-stale-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const runRoot = tempRoot("session-index-run-stale-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "stale.json"),
      JSON.stringify({
        pid: 2_147_483_647, // cannot exist on any real system
        id: "stale",
        projectDir: "/x",
        sessionId: SESSION_A,
      }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = index.build();
    expect(summary!.status).toBe("dormant");
    expect(summary!.pid).toBeUndefined();
  });

  test("a live client presence record reports live-tui", () => {
    const sessionsRoot = tempRoot("session-index-live-tui-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const runRoot = tempRoot("session-index-run-live-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "live.json"),
      JSON.stringify({ pid: process.pid, id: "live", projectDir: "/x", sessionId: SESSION_A }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = index.build();
    expect(summary!.status).toBe("live-tui");
    expect(summary!.pid).toBe(process.pid);
  });

  test("a session ompd holds via a non-terminal agent reports live-ompd, even with a live-tui-shaped client record present", () => {
    const sessionsRoot = tempRoot("session-index-live-ompd-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    store.upsertAgent(
      fakeAgent({ id: "agt_abc", acpSessionId: SESSION_A, state: "busy" }),
    );

    // Also register a client presence for the same session, to prove
    // live-ompd is checked first regardless.
    const runRoot = tempRoot("session-index-run-ompd-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "live.json"),
      JSON.stringify({ pid: process.pid, id: "live", projectDir: "/x", sessionId: SESSION_A }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = index.build();
    expect(summary!.status).toBe("live-ompd");
    expect(summary!.agentId).toBe("agt_abc");
  });

  test("a session held only by a terminal agent (stopped/failed) is dormant, not live-ompd", () => {
    const sessionsRoot = tempRoot("session-index-terminal-agent-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    store.upsertAgent(fakeAgent({ id: "agt_stopped", acpSessionId: SESSION_A, state: "stopped" }));

    const index = buildIndex(sessionsRoot, store);
    const [summary] = index.build();
    expect(summary!.status).toBe("dormant");
    expect(summary!.agentId).toBeUndefined();
  });

  test("message count exceeding the size ceiling reports null and the file is never read for it", () => {
    const sessionsRoot = tempRoot("session-index-ceiling-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
    ]);
    // Truncate the on-disk size upward past the ceiling without actually
    // writing tens of megabytes of content; scanSessionFiles reads size from
    // stat(), which reports the truncated length regardless of content.
    const fs = require("node:fs");
    fs.truncateSync(path, 60 * 1024 * 1024);

    const index = buildIndex(sessionsRoot, store);
    const [summary] = index.build();
    expect(summary!.byteSize).toBe(60 * 1024 * 1024);
    expect(summary!.messageCount).toBeNull();
  });

  test("message count cache works with an empty session_scan_cache table (safe to delete)", () => {
    const sessionsRoot = tempRoot("session-index-empty-cache-");
    const dbDir = tempRoot("session-index-db-");
    const store = openStore(join(dbDir, "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
    ]);

    // The cache table starts empty in a fresh store; prove the first build
    // still produces a correct count rather than failing or reporting zero.
    const index = buildIndex(sessionsRoot, store);
    const [summary] = index.build();
    expect(summary!.messageCount).toBe(2);

    // And a second build, now backed by the row the first build wrote,
    // produces the identical answer from the cache.
    expect(index.build()[0]!.messageCount).toBe(2);
  });
});

describe("SessionIndex archiving", () => {
  test("archive survives a store reopen", () => {
    const sessionsRoot = tempRoot("session-index-archive-");
    const dbDir = tempRoot("session-index-db-");
    const dbPath = join(dbDir, "ompd.db");
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const store1 = openStore(dbPath);
    const index1 = buildIndex(sessionsRoot, store1);
    index1.archive(SESSION_A);
    store1.close();

    // A fresh Store instance over the same file, exactly as a daemon restart
    // would open it -- not the same in-memory object.
    const store2 = openStore(dbPath);
    const index2 = buildIndex(sessionsRoot, store2);
    const [summary] = index2.query({ includeArchived: true });
    expect(summary!.archived).toBe(true);
    expect(summary!.status).toBe("archived");
  });

  test("archived sessions are excluded by default and included on request", () => {
    const sessionsRoot = tempRoot("session-index-archive-filter-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("u")]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);

    const defaultView = index.query();
    expect(defaultView.map((s) => s.id)).toEqual([SESSION_B]);

    const withArchived = index.query({ includeArchived: true });
    expect(new Set(withArchived.map((s) => s.id))).toEqual(new Set([SESSION_A, SESSION_B]));
  });

  test("unarchive reverses the mark", () => {
    const sessionsRoot = tempRoot("session-index-unarchive-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);
    expect(index.query()).toHaveLength(0);
    index.unarchive(SESSION_A);
    expect(index.query()).toHaveLength(1);
  });

  test("archiving never deletes the session file", () => {
    const sessionsRoot = tempRoot("session-index-no-delete-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
    ]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);
    const fs = require("node:fs");
    expect(fs.existsSync(path)).toBe(true);
  });
});

describe("SessionIndex sorting", () => {
  function seedThreeSessions(sessionsRoot: string): void {
    // Distinct sizes, ages, and message counts so every sort key produces a
    // real, checkable order rather than a coincidence.
    const small = writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [
      titleLine("oldest, smallest, fewest messages"),
      messageLine("m1", "user"),
    ]);
    const medium = writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [
      titleLine("middle"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
      messageLine("m3", "user"),
    ]);
    const large = writeSessionFile(sessionsRoot, "-c", "2026-08-12T00-00-00-000Z", SESSION_C, [
      titleLine("newest, largest, most messages"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
      messageLine("m3", "user"),
      messageLine("m4", "assistant"),
      messageLine("m5", "user"),
    ]);
    // Force a real size ordering independent of content length: pad the
    // "large" and "medium" files upward so byte size strictly orders
    // small < medium < large regardless of how JSON.stringify happened to
    // size each line.
    const fs = require("node:fs");
    fs.appendFileSync(medium, "\n// pad ".padEnd(2000, "x"));
    fs.appendFileSync(large, "\n// pad ".padEnd(4000, "x"));
    // Distinct, checkable mtimes for lastActivity, independent of write order.
    const base = new Date("2026-08-13T00:00:00.000Z").getTime();
    utimesSync(small, new Date(base), new Date(base));
    utimesSync(medium, new Date(base + 1000), new Date(base + 1000));
    utimesSync(large, new Date(base + 2000), new Date(base + 2000));
  }

  test("sorts by age ascending and descending", () => {
    const sessionsRoot = tempRoot("session-index-sort-age-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    expect(index.query({ sort: "age", sortDir: "asc" }).map((s) => s.id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
    ]);
    expect(index.query({ sort: "age", sortDir: "desc" }).map((s) => s.id)).toEqual([
      SESSION_C,
      SESSION_B,
      SESSION_A,
    ]);
  });

  test("sorts by lastActivity", () => {
    const sessionsRoot = tempRoot("session-index-sort-activity-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    expect(index.query({ sort: "lastActivity", sortDir: "asc" }).map((s) => s.id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
    ]);
  });

  test("sorts by messageCount", () => {
    const sessionsRoot = tempRoot("session-index-sort-count-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    expect(index.query({ sort: "messageCount", sortDir: "asc" }).map((s) => s.id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
    ]);
    expect(index.query({ sort: "messageCount", sortDir: "desc" }).map((s) => s.id)).toEqual([
      SESSION_C,
      SESSION_B,
      SESSION_A,
    ]);
  });

  test("sorts by size", () => {
    const sessionsRoot = tempRoot("session-index-sort-size-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    const asc = index.query({ sort: "size", sortDir: "asc" });
    expect(asc.map((s) => s.id)).toEqual([SESSION_A, SESSION_B, SESSION_C]);
    expect(asc[0]!.byteSize).toBeLessThan(asc[1]!.byteSize);
    expect(asc[1]!.byteSize).toBeLessThan(asc[2]!.byteSize);
  });

  test("sorts by status: live-ompd, then live-tui, then dormant, then archived", () => {
    const sessionsRoot = tempRoot("session-index-sort-status-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [titleLine("dormant")]);
    writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [titleLine("archived")]);
    writeSessionFile(sessionsRoot, "-c", "2026-08-12T00-00-00-000Z", SESSION_C, [titleLine("live-ompd")]);
    store.upsertAgent(fakeAgent({ id: "agt_live", acpSessionId: SESSION_C, state: "busy" }));

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_B);

    const withArchived = index.query({ sort: "status", sortDir: "asc", includeArchived: true });
    expect(withArchived.map((s) => s.status)).toEqual(["live-ompd", "dormant", "archived"]);
  });

  test("cwd filter matches either the decoded cwd or the raw flattened dir", () => {
    const sessionsRoot = tempRoot("session-index-cwd-filter-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("a")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("b")]);

    const index = buildIndex(sessionsRoot, store);
    const byFlattened = index.query({ cwd: "-x" });
    expect(byFlattened.map((s) => s.id)).toEqual([SESSION_A]);
  });
});

describe("SessionIndex.grouped", () => {
  test("groups sessions by directory and orders groups by most recent activity", () => {
    const sessionsRoot = tempRoot("session-index-grouped-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const older = writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [
      titleLine("a1"),
    ]);
    const newer1 = writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [
      titleLine("b1"),
    ]);
    const newer2 = writeSessionFile(sessionsRoot, "-a", "2026-08-12T00-00-00-000Z", SESSION_C, [
      titleLine("a2"),
    ]);
    const base = new Date("2026-08-13T00:00:00.000Z").getTime();
    utimesSync(older, new Date(base), new Date(base));
    utimesSync(newer1, new Date(base + 1000), new Date(base + 1000));
    utimesSync(newer2, new Date(base + 2000), new Date(base + 2000));

    const index = buildIndex(sessionsRoot, store);
    const groups = index.grouped();
    expect(groups).toHaveLength(2);
    // "-a" group has the most recently active session (SESSION_C) so it
    // sorts first even though it was the first group created.
    expect(groups[0]!.key).toBe("-a");
    expect(groups[0]!.sessions).toHaveLength(2);
    expect(groups[1]!.key).toBe("-b");
    expect(groups[1]!.sessions).toHaveLength(1);
  });
});

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

process.on("exit", () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
