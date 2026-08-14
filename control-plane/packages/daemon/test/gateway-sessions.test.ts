/**
 * `/v1/sessions*` from the wire: scope enforcement, the feature-off 503 when
 * no `SessionIndex` is wired in, and that grouping/sorting genuinely happen
 * server-side rather than being decoration the client would have to redo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store } from "@ompd/core";
import { HostRegistry } from "../src/hosts.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  title: string,
  mtime: Date,
): void {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const line = JSON.stringify({ type: "title", v: 1, title, updatedAt: new Date().toISOString() });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${line}\n`);
  // Explicit, deterministic mtime: writes inside one test can land on the
  // same filesystem-clock tick under load, which made lastActivity ordering
  // flaky when it depended on real write timing.
  utimesSync(filePath, mtime, mtime);
}

interface Harness {
  base: string;
  pair(scopes: string[]): Promise<string>;
  http(path: string, init?: RequestInit, token?: string): Promise<Response>;
  gateway: Gateway;
}

async function harness(opts: { withSessionIndex?: boolean } = {}): Promise<Harness> {
  const withSessionIndex = opts.withSessionIndex ?? true;
  const dbPath = join(tempDir("gw-sessions-db-"), "ompd.db");
  paths.push(dbPath);
  const store = new Store(dbPath);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const sessionsRoot = tempDir("gw-sessions-tree-");
  const emptyRunRoot = tempDir("gw-sessions-empty-run-");
  const sessionIndex = withSessionIndex
    ? new SessionIndex({ store, sessionsRoot, runDaemonsRoot: emptyRunRoot })
    : undefined;

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    ...(sessionIndex ? { sessionIndex } : {}),
  });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  if (withSessionIndex) {
    const mtimeBase = new Date("2026-08-13T00:00:00.000Z").getTime();
    writeSessionFile(
      sessionsRoot,
      "-a",
      "2026-08-10T00-00-00-000Z",
      "aaaaaaaa-0000-7000-0000-000000000001",
      "first",
      new Date(mtimeBase),
    );
    writeSessionFile(
      sessionsRoot,
      "-b",
      "2026-08-11T00-00-00-000Z",
      "bbbbbbbb-0000-7000-0000-000000000002",
      "second",
      new Date(mtimeBase + 1000),
    );
    writeSessionFile(
      sessionsRoot,
      "-b",
      "2026-08-12T00-00-00-000Z",
      "cccccccc-0000-7000-0000-000000000003",
      "third",
      new Date(mtimeBase + 2000),
    );
  }

  return {
    base,
    gateway: gw,
    pair: async (scopes) => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    http: (routePath, init = {}, token) => {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${base}${routePath}`, { ...init, headers });
    },
  };
}

describe("GET /v1/sessions", () => {
  test("requires the read scope", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]); // holds prompt, not read
    const res = await h.http("/v1/sessions", {}, token);
    expect(res.status).toBe(403);
  });

  test("lists every session across every cwd group", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions", {}, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; flattenedDir: string }> };
    expect(body.sessions).toHaveLength(3);
    expect(new Set(body.sessions.map((s) => s.flattenedDir))).toEqual(new Set(["-a", "-b"]));
  });

  test("reports the feature off when no SessionIndex is wired in", async () => {
    const h = await harness({ withSessionIndex: false });
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions", {}, token);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({ error: "sessions_unavailable" });
  });

  test("sorts server-side by lastActivity descending by default", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions", {}, token);
    const body = (await res.json()) as { sessions: Array<{ id: string }> };
    // Newest-written (explicit mtime) first: default sort is lastActivity,
    // not createdAt, so this also proves the two are not conflated.
    expect(body.sessions.map((s) => s.id)).toEqual([
      "cccccccc-0000-7000-0000-000000000003",
      "bbbbbbbb-0000-7000-0000-000000000002",
      "aaaaaaaa-0000-7000-0000-000000000001",
    ]);
  });

  test("sort=age&sortDir=asc reorders the response, not left to the client", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions?sort=age&sortDir=asc", {}, token);
    const body = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((s) => s.id)).toEqual([
      "aaaaaaaa-0000-7000-0000-000000000001",
      "bbbbbbbb-0000-7000-0000-000000000002",
      "cccccccc-0000-7000-0000-000000000003",
    ]);
  });

  test("an unrecognized sort key is rejected with a client error, not silently ignored", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions?sort=not-a-real-key", {}, token);
    expect(res.status).toBe(400);
  });

  test("cwd filter narrows to one directory", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions?cwd=-b", {}, token);
    const body = (await res.json()) as { sessions: Array<{ flattenedDir: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.every((s) => s.flattenedDir === "-b")).toBe(true);
  });
});

describe("GET /v1/sessions/grouped", () => {
  test("requires the read scope", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]);
    const res = await h.http("/v1/sessions/grouped", {}, token);
    expect(res.status).toBe(403);
  });

  test("groups sessions by directory server-side", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions/grouped", {}, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ key: string; sessions: unknown[] }> };
    expect(body.groups).toHaveLength(2);
    const byKey = new Map(body.groups.map((g) => [g.key, g.sessions.length]));
    expect(byKey.get("-a")).toBe(1);
    expect(byKey.get("-b")).toBe(2);
  });
});

describe("POST /v1/sessions/:id/archive and /unarchive", () => {
  const SESSION_ID = "aaaaaaaa-0000-7000-0000-000000000001";

  test("archive requires the manage scope, not just read", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http(`/v1/sessions/${SESSION_ID}/archive`, { method: "POST" }, token);
    expect(res.status).toBe(403);
  });

  test("archiving removes a session from the default list and unarchiving restores it", async () => {
    const h = await harness();
    const manageToken = await h.pair([SCOPE_READ, SCOPE_MANAGE]);

    const archiveRes = await h.http(
      `/v1/sessions/${SESSION_ID}/archive`,
      { method: "POST" },
      manageToken,
    );
    expect(archiveRes.status).toBe(200);

    const afterArchive = (await (await h.http("/v1/sessions", {}, manageToken)).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(afterArchive.sessions.map((s) => s.id)).not.toContain(SESSION_ID);

    const withArchived = (await (
      await h.http("/v1/sessions?includeArchived=true", {}, manageToken)
    ).json()) as { sessions: Array<{ id: string; archived: boolean }> };
    const row = withArchived.sessions.find((s) => s.id === SESSION_ID);
    expect(row?.archived).toBe(true);

    const unarchiveRes = await h.http(
      `/v1/sessions/${SESSION_ID}/unarchive`,
      { method: "POST" },
      manageToken,
    );
    expect(unarchiveRes.status).toBe(200);

    const afterUnarchive = (await (await h.http("/v1/sessions", {}, manageToken)).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(afterUnarchive.sessions.map((s) => s.id)).toContain(SESSION_ID);
  });
});

describe("POST /v1/sessions/:id/takeover", () => {
  test("claims the registered TUI ACP leg and adopts its one live session", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_MANAGE]);
    const requested = Promise.withResolvers<void>();
    let deliver: ((raw: string) => void) | undefined;
    const tunnel = h.gateway.acceptTunnelSession(token, raw => {
      const frame = JSON.parse(raw);
      if (typeof frame !== "object" || frame === null || !("t" in frame)) return;
      if (frame.t === "tui_takeover") {
        requested.resolve();
        return;
      }
      if (frame.t !== "tui_acp" || typeof frame.raw !== "string") return;
      const rpc = JSON.parse(frame.raw);
      if (
        typeof rpc !== "object" ||
        rpc === null ||
        !("id" in rpc) ||
        (typeof rpc.id !== "string" && typeof rpc.id !== "number")
      ) {
        return;
      }
      deliver?.(
        JSON.stringify({
          t: "tui_acp",
          sessionId: "live-tui-session",
          raw: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} }),
        }),
      );
    });
    if (!tunnel.ok) throw new Error(`could not open paired TUI tunnel: ${tunnel.reason}`);
    deliver = tunnel.deliver;
    deliver(
      JSON.stringify({
        t: "tui_register",
        sessionId: "live-tui-session",
        cwd: "/repo",
        title: "Live terminal",
        pid: 4242,
      }),
    );

    const takeover = h.http("/v1/sessions/live-tui-session/takeover", { method: "POST" }, token);
    await requested.promise;
    deliver(JSON.stringify({ t: "tui_acp_ready", sessionId: "live-tui-session" }));

    const response = await takeover;
    expect(response.status).toBe(201);
    const body = (await response.json()) as { agent: { acpSessionId: string; cwd: string; state: string } };
    expect(body.agent).toMatchObject({ acpSessionId: "live-tui-session", cwd: "/repo", state: "idle" });
  });
});

afterEach(async () => {
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

process.on("exit", () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
