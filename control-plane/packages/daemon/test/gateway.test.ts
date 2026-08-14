/**
 * The gateway is the part of ompd reachable from someone else's network, so
 * these tests are written from the attacker's side of the wire.
 *
 * Three properties carry most of the weight.
 *
 * Pairing must not be a privilege grant. `POST /v1/pair` is unauthenticated by
 * necessity, so if anything it returned could be presented to another route,
 * every scope check behind it would be decorative.
 *
 * A client's `decide` is evidence, not a decision. The interesting case is a
 * phone that holds read and prompt but not approve: it can see an approval and
 * answer it, and the answer must change nothing. That test is paired with its
 * mirror image, because "the tool did not run" is also what a broken decide
 * path, a dropped frame, or a crashed host look like. Only asserting both
 * directions distinguishes enforcement from breakage, which is the trap named
 * in docs/acp-approval-gate.md.
 *
 * Replay must be exact. A phone that drops mid-turn reattaches with `sinceSeq`
 * and has to receive every frame it missed and not one it already has. This is
 * the reason updates are persisted at all, so the assertion is on the precise
 * sequence, not on a count.
 *
 * Nothing here sleeps. Every wait is on a real signal: an incoming frame, or a
 * supervisor event subscribed to before the action that triggers it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DefaultPolicy,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  Store,
  type Agent,
  type AgentId,
  type ClientFrame,
  type ServerFrame,
  type WebViewActionResult,
} from "@ompd/core";
import { Supervisor } from "../src/supervisor.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Gateway, GatewayEvents, type RoutineRunner } from "../src/gateway/index.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

/**
 * Deadline for waiting on a signal that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 3000;

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];
const gateways: Gateway[] = [];
const sockets: SocketClient[] = [];

type UpdateFrame = Extract<ServerFrame, { t: "update" }>;

function isUpdateFrame(frame: ServerFrame): frame is UpdateFrame {
  return frame.t === "update";
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  /** Bypasses JSON encoding, so a test can put garbage on the wire. */
  sendRaw(raw: string): void;
  /** Resolve with the next frame matching `match`, driven by arrival. */
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  /** Resolve once `predicate` holds, re-checked on every arriving frame. */
  until(predicate: () => boolean, label: string): Promise<void>;
  close(): void;
}

interface Harness {
  gw: Gateway;
  sup: Supervisor;
  store: Store;
  fake: FakeHostController;
  hosts: HostRegistry;
  events: GatewayEvents;
  base: string;
  port: number;
  /** Runs the real two-step pairing flow and returns the minted token. */
  pair(name: string, scopes: string[]): Promise<string>;
  http(path: string, init?: RequestInit, token?: string): Promise<Response>;
}

async function harness(
  opts: {
    approvalTimeoutMs?: number;
    onWebViewResult?: (agentId: AgentId, requestId: string, result: WebViewActionResult) => boolean;
    routines?: RoutineRunner;
  } = {},
): Promise<Harness> {
  const path = `/tmp/ompd-gateway-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  // The same wrapping the daemon does, for the same reason: the supervisor
  // gets a factory that indexes every host it spawns, and the gateway gets the
  // index. Without it the config routes have nothing to answer from.
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 500,
    spawnHost: hosts.spawn,
    events,
  });
  sups.push(sup);

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    onWebViewResult: opts.onWebViewResult,
    routines: opts.routines,
  });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  return {
    gw,
    sup,
    store,
    fake,
    hosts,
    events,
    base,
    port,
    pair: async (name, scopes) => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${name}` }),
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

/** Resolves null when the server refused the upgrade. */
async function connect(port: number, token: string | null): Promise<SocketClient | null> {
  const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket${query}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: () => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending) return;
    if (!pending.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.settle();
  };

  ws.addEventListener("open", () => opened.resolve(true));
  ws.addEventListener("error", () => opened.resolve(false));
  ws.addEventListener("close", () => opened.resolve(false));
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) return null;

  const client: SocketClient = {
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (raw) => ws.send(raw),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      let found: ServerFrame | null = null;
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor advances past frames that do not match, so a later `next`
        // never re-matches a frame an earlier one already stepped over.
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) {
              found = frame;
              return true;
            }
          }
          return false;
        },
        settle: () => {
          if (found) settled.resolve(found);
        },
        timer,
      };
      drain();
      return settled.promise;
    },
    until: (predicate, label) => {
      const settled = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = { check: predicate, settle: () => settled.resolve(), timer };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
  sockets.push(client);
  return client;
}

async function openSocket(port: number, token: string): Promise<SocketClient> {
  const client = await connect(port, token);
  if (!client) throw new Error("expected the websocket to open");
  return client;
}

/**
 * Arm a wait for an agent's update log to reach `seq` before triggering it.
 *
 * Subscribing to the supervisor's own event is what makes this deterministic:
 * the alternative is polling the store, which turns a race into a delay rather
 * than removing it.
 */
function updateReaching(h: Harness, agentId: AgentId, seq: number): Promise<void> {
  const settled = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => settled.reject(new Error(`timed out waiting for ${agentId} to reach seq ${seq}`)),
    SIGNAL_DEADLINE_MS,
  );
  const off = h.events.add({
    onUpdate: (id, reached) => {
      if (id !== agentId || reached < seq) return;
      clearTimeout(timer);
      settled.resolve();
    },
  });
  return settled.promise.finally(off);
}

/**
 * Resolve once the supervisor is holding a pending approval for `agentId`.
 *
 * Driven by the supervisor's own event rather than by polling, and armed the
 * same way `updateReaching` is. The approval may already be pending by the
 * time this is called, so the current list is checked first: a test that
 * blocks an agent and only then subscribes would otherwise wait for an event
 * that has already fired.
 */
function waitForPending(h: Harness, agentId: AgentId): Promise<void> {
  if (h.sup.pendingApprovals().some((approval) => approval.agentId === agentId)) {
    return Promise.resolve();
  }
  const settled = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => settled.reject(new Error(`timed out waiting for ${agentId} to block on an approval`)),
    SIGNAL_DEADLINE_MS,
  );
  const off = h.events.add({
    onApprovalNeeded: (approval) => {
      if (approval.agentId !== agentId) return;
      clearTimeout(timer);
      settled.resolve();
    },
  });
  return settled.promise.finally(off);
}

/**
 * Create an agent over HTTP, which is also how a test learns an agent id the
 * way a client would.
 */
async function createAgent(h: Harness, token: string, name: string, cwd = "/work"): Promise<Agent> {
  const res = await h.http(
    "/v1/agents",
    { method: "POST", body: JSON.stringify({ name, cwd }) },
    token,
  );
  if (res.status !== 201) throw new Error(`agent creation failed with ${res.status}`);
  const body = (await res.json()) as { agent: Agent };
  return body.agent;
}

const bashCall = (command: string) => ({
  toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
  title: command,
  kind: "execute",
  rawInput: { command },
});

/**
 * Round-trip a ping. Frames on one socket are ordered, so a pong proves every
 * frame sent before it has been processed, and proves anything the server was
 * going to push in that window has already been pushed.
 */
async function barrier(sock: SocketClient, label: string): Promise<void> {
  sock.send({ t: "ping" });
  await sock.next((f) => f.t === "pong", `pong barrier: ${label}`);
}

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

describe("socket authentication", () => {
  test("a socket with no token is refused", async () => {
    const h = await harness();
    expect(await connect(h.port, null)).toBeNull();
  });

  test("a socket with an invented token is refused", async () => {
    const h = await harness();
    expect(await connect(h.port, "not-a-real-token")).toBeNull();
  });

  test("a revoked device loses both the socket and HTTP", async () => {
    const h = await harness();
    const token = await h.pair("phone", [SCOPE_READ]);

    // Works first, so the revocation below is the only thing that changed.
    const before = await openSocket(h.port, token);
    const hello = await before.next((f) => f.t === "hello", "hello");
    if (hello.t !== "hello") throw new Error("expected a hello frame");
    expect((await h.http("/v1/agents", {}, token)).status).toBe(200);
    before.close();

    h.gw.revokeDevice(hello.deviceId);

    expect(await connect(h.port, token)).toBeNull();
    expect((await h.http("/v1/agents", {}, token)).status).toBe(401);
  });

  test("HTTP without a token is refused", async () => {
    const h = await harness();
    expect((await h.http("/v1/agents")).status).toBe(401);
  });
});

describe("pairing", () => {
  test("pairing grants nothing until the operator approves", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk_phone" }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // Nothing presentable comes back: no token, no scopes, no device id.
    expect(Object.keys(body)).toEqual(["code"]);
    const code = body.code;
    if (typeof code !== "string") throw new Error("pair response carried no code");

    expect(h.store.listAudit().filter((e) => e.action === "device.pair")).toHaveLength(0);
    expect(await connect(h.port, code)).toBeNull();
    expect((await h.http("/v1/agents", {}, code)).status).toBe(401);

    const token = h.gw.approvePairing(code, [SCOPE_READ]);
    expect((await h.http("/v1/agents", {}, token)).status).toBe(200);
    expect(h.store.listAudit().filter((e) => e.action === "device.pair")).toHaveLength(1);
  });

  test("a pairing code is single use", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk_phone" }),
    });
    const body = (await res.json()) as { code: string };

    h.gw.approvePairing(body.code, [SCOPE_READ]);
    expect(() => h.gw.approvePairing(body.code, [SCOPE_MANAGE])).toThrow();
  });

  test("scopes named by the client in the pairing body are ignored", async () => {
    // The whole reason pairing is two-step. A client that could pick its own
    // scopes would make every check behind this route decorative.
    const h = await harness();
    const res = await fetch(`${h.base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "hostile",
        publicKey: "pk_hostile",
        scopes: [SCOPE_MANAGE, SCOPE_APPROVE],
      }),
    });
    const body = (await res.json()) as { code: string };
    const token = h.gw.approvePairing(body.code, [SCOPE_READ]);

    const created = await h.http(
      "/v1/agents",
      { method: "POST", body: JSON.stringify({ name: "x", cwd: "/work" }) },
      token,
    );
    expect(created.status).toBe(403);
    expect(h.sup.listAgents()).toHaveLength(0);
  });

  test("device.revoke is audited", async () => {
    const h = await harness();
    const token = await h.pair("phone", [SCOPE_READ]);
    const sock = await openSocket(h.port, token);
    const hello = await sock.next((f) => f.t === "hello", "hello");
    if (hello.t !== "hello") throw new Error("expected a hello frame");

    h.gw.revokeDevice(hello.deviceId);
    expect(h.store.listAudit().filter((e) => e.action === "device.revoke")).toHaveLength(1);
  });
});

describe("token rotation over http", () => {
  test("a device can rotate its own token with no scopes at all", async () => {
    // Replacing your own credential withdraws authority you already hold and
    // hands the same authority back under a new secret. Gating it would mean
    // the least trusted device is the one that cannot react to a leak.
    const h = await harness();
    const token = await h.pair("gadget", []);

    const res = await h.http("/v1/tokens/rotate", { method: "POST" }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; deviceId: string; revoked: number };
    expect(body.revoked).toBe(1);

    // Old refused, new accepted, and the new one carries the same scopes:
    // none, so `/v1/agents` is a 403 rather than a 401.
    expect((await h.http("/v1/agents", {}, token)).status).toBe(401);
    expect((await h.http("/v1/agents", {}, body.token)).status).toBe(403);
  });

  test("rotating another device needs manage scope", async () => {
    const h = await harness();
    const phone = await h.pair("phone", [SCOPE_READ]);
    const other = await h.pair("laptop", [SCOPE_READ]);
    const target = h.store.listDevices().find((d) => d.name === "laptop")?.id ?? "";

    const res = await h.http(
      "/v1/tokens/rotate",
      { method: "POST", body: JSON.stringify({ deviceId: target }) },
      phone,
    );
    expect(res.status).toBe(403);
    // And the target is untouched, so a refused rotation is not a denial of
    // service against the device it named.
    expect((await h.http("/v1/agents", {}, other)).status).toBe(200);
  });

  test("rotating a device more powerful than the caller is refused", async () => {
    // The same clamp pairing approval uses. Without it, `manage` alone would
    // be a route to a working `approve` credential, and a device could sign
    // its own tool approvals through the back door.
    const h = await harness();
    const manager = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const approver = await h.pair("console", [SCOPE_READ, SCOPE_APPROVE]);
    const target = h.store.listDevices().find((d) => d.name === "console")?.id ?? "";

    const res = await h.http(
      "/v1/tokens/rotate",
      { method: "POST", body: JSON.stringify({ deviceId: target }) },
      manager,
    );
    expect(res.status).toBe(403);
    const refusal = (await res.json()) as { missing: string[] };
    expect(refusal.missing).toEqual([SCOPE_APPROVE]);
    expect((await h.http("/v1/agents", {}, approver)).status).toBe(200);
  });

  test("an operator rotates a device it fully outranks", async () => {
    // The mirror of the two refusals above. Without it they would both still
    // pass if the route were broken outright.
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_APPROVE]);
    const phone = await h.pair("phone", [SCOPE_READ]);
    const target = h.store.listDevices().find((d) => d.name === "phone")?.id ?? "";

    const res = await h.http(
      "/v1/tokens/rotate",
      { method: "POST", body: JSON.stringify({ deviceId: target }) },
      operator,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; deviceId: string };
    expect(body.deviceId).toBe(target);

    expect((await h.http("/v1/agents", {}, phone)).status).toBe(401);
    expect((await h.http("/v1/agents", {}, body.token)).status).toBe(200);
    // The operator's own credential is not collateral damage.
    expect((await h.http("/v1/agents", {}, operator)).status).toBe(200);
  });

  test("rotating an unknown device is a 404, and rotation needs a token", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_APPROVE]);

    const missing = await h.http(
      "/v1/tokens/rotate",
      { method: "POST", body: JSON.stringify({ deviceId: "dev_nope" }) },
      operator,
    );
    expect(missing.status).toBe(404);

    // Unauthenticated rotation would be a way to invalidate every credential
    // on the daemon from outside it.
    expect((await h.http("/v1/tokens/rotate", { method: "POST" })).status).toBe(401);
  });

  test("a rotated socket credential is refused at the handshake", async () => {
    const h = await harness();
    const token = await h.pair("phone", [SCOPE_READ]);
    const before = await openSocket(h.port, token);
    await before.next((f) => f.t === "hello", "hello");
    before.close();

    const res = await h.http("/v1/tokens/rotate", { method: "POST" }, token);
    const { token: replacement } = (await res.json()) as { token: string };

    expect(await connect(h.port, token)).toBeNull();
    const after = await openSocket(h.port, replacement);
    expect((await after.next((f) => f.t === "hello", "hello")).t).toBe("hello");
  });
});

describe("http scopes", () => {
  test("a read-only device cannot create an agent", async () => {
    const h = await harness();
    const readOnly = await h.pair("phone", [SCOPE_READ]);

    const created = await h.http(
      "/v1/agents",
      { method: "POST", body: JSON.stringify({ name: "x", cwd: "/work" }) },
      readOnly,
    );
    expect(created.status).toBe(403);
    expect(h.sup.listAgents()).toHaveLength(0);
    // Refused by the gateway itself rather than deflected by the supervisor.
    // A request that fails a scope check must not reach the privileged layer,
    // so there is no supervisor-side denial recorded against it.
    expect(h.store.listAudit().filter((e) => e.outcome === "denied")).toHaveLength(0);

    // Positive controls, so the 403 above is about scope and not about the
    // route being broken for everyone.
    expect((await h.http("/v1/agents", {}, readOnly)).status).toBe(200);
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "real");
    expect(agent.name).toBe("real");
    expect(h.sup.listAgents()).toHaveLength(1);
  });

  test("a read-only device cannot delete an agent", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const readOnly = await h.pair("phone", [SCOPE_READ]);
    const agent = await createAgent(h, manage, "keeper");

    const refused = await h.http(`/v1/agents/${agent.id}`, { method: "DELETE" }, readOnly);
    expect(refused.status).toBe(403);
    expect(h.store.getAgent(agent.id)?.state).not.toBe("stopped");
    expect(h.store.listAudit().filter((e) => e.outcome === "denied")).toHaveLength(0);

    const allowed = await h.http(`/v1/agents/${agent.id}`, { method: "DELETE" }, manage);
    expect(allowed.status).toBe(200);
    expect(h.store.getAgent(agent.id)?.state).toBe("stopped");
  });

  test("audit and approvals need read scope", async () => {
    const h = await harness();
    const noRead = await h.pair("gadget", [SCOPE_PROMPT]);
    expect((await h.http("/v1/audit", {}, noRead)).status).toBe(403);
    expect((await h.http("/v1/approvals", {}, noRead)).status).toBe(403);

    const reader = await h.pair("phone", [SCOPE_READ]);
    expect((await h.http("/v1/audit", {}, reader)).status).toBe(200);
    expect((await h.http("/v1/approvals", {}, reader)).status).toBe(200);
  });
});

describe("health", () => {
  test("health is unauthenticated and carries nothing but liveness", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "secret-project-agent", "/work/secret-repo");

    const res = await fetch(`${h.base}/v1/health`);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, version: expect.any(String) });
    expect(text).not.toContain("secret-project-agent");
    expect(text).not.toContain("secret-repo");
    expect(text).not.toContain(agent.id);
  });
});

describe("webhook route", () => {
  test("uses only a per-routine secret and returns the scheduler run", async () => {
    const deliveries: Array<{ routineId: string; secret: string }> = [];
    const h = await harness({
      routines: {
        runNow: async () => {
          throw new Error("manual route was called");
        },
        fireWebhook: async (routineId, secret) => {
          deliveries.push({ routineId, secret });
          if (secret !== "webhook-secret") return { accepted: false, reason: "forbidden" };
          return {
            accepted: true,
            run: {
              id: "run_webhook",
              routineId,
              state: "succeeded",
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:00:01.000Z",
            },
          };
        },
      },
    });

    const accepted = await fetch(`${h.base}/v1/webhooks/rtn_webhook`, {
      method: "POST",
      headers: { "x-webhook-secret": "webhook-secret" },
      body: "raw webhook body",
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ run: expect.objectContaining({ id: "run_webhook" }) });
    expect(deliveries).toEqual([{ routineId: "rtn_webhook", secret: "webhook-secret" }]);

    const refused = await fetch(`${h.base}/v1/webhooks/rtn_webhook`, {
      method: "POST",
      headers: { "x-webhook-secret": "wrong-secret" },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "webhook_refused" });
  });
});

describe("requests with no Host header", () => {
  test("a Host-less request is refused cleanly and the daemon stays up", async () => {
    // HTTP/1.0 does not require a Host header, and without one `req.url`
    // arrives as a bare path. Parsing it as absolute threw inside the request
    // handler before any authentication ran, so anything that could open the
    // port could raise an unhandled exception on every request it sent.
    //
    // The property is that the daemon answers and survives, which is why the
    // health check afterwards matters more than the status code.
    const h = await harness();

    const { promise, resolve } = Promise.withResolvers<string>();
    let received = "";
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: h.port,
      socket: {
        open: (s) => {
          s.write("GET /v1/agents HTTP/1.0\r\n\r\n");
        },
        data: (_s, chunk) => {
          received += chunk.toString();
          if (received.includes("\r\n")) resolve(received);
        },
        close: () => resolve(received),
      },
    });
    const raw = await promise;
    socket.end();

    expect(raw).toMatch(/^HTTP\/1\.[01] 4\d\d/);

    const after = await fetch(`${h.base}/v1/health`);
    expect(after.status).toBe(200);
  });
});

describe("agent-driven WebView routing", () => {
  test("routes an action and its correlated result through the registered attached socket", async () => {
    const results: Array<{ agentId: AgentId; requestId: string; result: WebViewActionResult }> = [];
    const h = await harness({
      onWebViewResult: (agentId, requestId, result) => {
        results.push({ agentId, requestId, result });
        return true;
      },
    });
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, operator, "worker");
    const phone = await openSocket(h.port, operator);

    expect(h.gw.sendWebViewAction(agent.id, "before-register", { kind: "observe" })).toBe(false);

    phone.send({ t: "attach", agentId: agent.id });
    phone.send({ t: "webview_register", agentId: agent.id });
    await barrier(phone, "webview registration");

    expect(h.gw.sendWebViewAction(agent.id, "wv_1", { kind: "navigate", url: "https://example.com" })).toBe(
      true,
    );
    const action = await phone.next((frame) => frame.t === "webview_action", "webview action");
    expect(action).toEqual({
      t: "webview_action",
      agentId: agent.id,
      requestId: "wv_1",
      action: { kind: "navigate", url: "https://example.com" },
    });

    phone.send({
      t: "webview_result",
      agentId: agent.id,
      requestId: "wv_1",
      result: { kind: "ack", url: "https://example.com", title: "Example" },
    });
    await barrier(phone, "webview result");
    expect(results).toEqual([
      {
        agentId: agent.id,
        requestId: "wv_1",
        result: { kind: "ack", url: "https://example.com", title: "Example" },
      },
    ]);

    phone.send({ t: "detach", agentId: agent.id });
    await barrier(phone, "webview detach");
    expect(h.gw.sendWebViewAction(agent.id, "after-detach", { kind: "observe" })).toBe(false);
  });

  test("rejects a result from any socket other than the registered target", async () => {
    const h = await harness({ onWebViewResult: () => true });
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, operator, "worker");
    const target = await openSocket(h.port, operator);
    target.send({ t: "attach", agentId: agent.id });
    target.send({ t: "webview_register", agentId: agent.id });
    await barrier(target, "target registration");

    const bystander = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    bystander.send({ t: "attach", agentId: agent.id });
    await barrier(bystander, "bystander attach");
    bystander.send({
      t: "webview_result",
      agentId: agent.id,
      requestId: "wv_spoofed",
      result: { kind: "ack", url: "https://attacker.invalid", title: "Spoof" },
    });

    const refusal = await bystander.next(
      (frame) => frame.t === "error" && frame.code === "webview_not_registered",
      "spoofed webview result refusal",
    );
    expect(refusal).toMatchObject({
      t: "error",
      agentId: agent.id,
      code: "webview_not_registered",
    });
  });
});

describe("approvals over the socket", () => {
  test("a phone without approve scope cannot approve a tool call", async () => {
    const h = await harness({ approvalTimeoutMs: 250 });
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");

    // Read and prompt, deliberately no approve.
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const sock = await openSocket(h.port, phone);
    sock.send({ t: "attach", agentId: agent.id });
    await barrier(sock, "attach");

    const option = h.fake.requestPermission(agent.acpSessionId ?? "", bashCall("echo hi"));

    const approval = await sock.next((f) => f.t === "approval", "approval");
    if (approval.t !== "approval") throw new Error("expected an approval frame");
    expect(approval.agentId).toBe(agent.id);
    expect(approval.tool).toBe("bash");

    sock.send({
      t: "decide",
      agentId: agent.id,
      requestId: approval.requestId,
      choice: "allow",
      scope: "once",
    });

    const refusal = await sock.next((f) => f.t === "error", "refusal");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    expect(refusal.code).toBe("unauthorized");

    // The only assertion that proves anything: what went back to the agent on
    // the wire. The phone answered allow and the agent was told reject.
    expect(await option).toBe("reject_once");
    const record = h.store.listApprovals(agent.id)[0];
    expect(record?.decision).toBe("deny");
    expect(record?.rule).toBe("timeout");
  });

  test("a device with approve scope does approve", async () => {
    // The mirror of the test above. Without it, that one would still pass if
    // decide were broken outright or the host had crashed, and it would be
    // enforcing nothing.
    const h = await harness({ approvalTimeoutMs: 3000 });
    const operator = await h.pair("laptop", [
      SCOPE_READ,
      SCOPE_MANAGE,
      SCOPE_PROMPT,
      SCOPE_APPROVE,
    ]);
    const agent = await createAgent(h, operator, "worker");

    const sock = await openSocket(h.port, operator);
    sock.send({ t: "attach", agentId: agent.id });
    await barrier(sock, "attach");

    const option = h.fake.requestPermission(agent.acpSessionId ?? "", bashCall("echo hi"));
    const approval = await sock.next((f) => f.t === "approval", "approval");
    if (approval.t !== "approval") throw new Error("expected an approval frame");

    sock.send({
      t: "decide",
      agentId: agent.id,
      requestId: approval.requestId,
      choice: "allow",
      scope: "once",
    });

    expect(await option).toBe("allow_once");
    const record = h.store.listApprovals(agent.id)[0];
    expect(record?.decision).toBe("allow");
    expect(record?.rule).toBe("operator");
  });

  test("an approval reaches only sockets attached to that agent", async () => {
    const h = await harness({ approvalTimeoutMs: 250 });
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await createAgent(h, operator, "worker");

    const watcher = await openSocket(h.port, operator);
    watcher.send({ t: "attach", agentId: agent.id });
    await barrier(watcher, "watcher attach");

    const bystander = await openSocket(h.port, await h.pair("other", [SCOPE_READ]));
    await barrier(bystander, "bystander ready");

    const option = h.fake.requestPermission(agent.acpSessionId ?? "", bashCall("echo hi"));
    await watcher.next((f) => f.t === "approval", "approval on the attached socket");

    await barrier(bystander, "bystander drain");
    expect(bystander.frames.filter((f) => f.t === "approval")).toHaveLength(0);
    await option;
  });
});

describe("replay", () => {
  test("attach with sinceSeq replays exactly the gap", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");
    const sessionId = agent.acpSessionId ?? "";

    // The turn continues while nobody is connected. This is the whole point of
    // persisting updates rather than forwarding them.
    const stored = updateReaching(h, agent.id, 3);
    h.fake.emitUpdate(sessionId, { n: 1 });
    h.fake.emitUpdate(sessionId, { n: 2 });
    h.fake.emitUpdate(sessionId, { n: 3 });
    await stored;

    // The phone comes back holding seq 1 and asks for everything after it.
    const phone = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    phone.send({ t: "attach", agentId: agent.id, sinceSeq: 1 });
    await phone.next((f) => isUpdateFrame(f) && f.seq === 3, "replayed seq 3");

    h.fake.emitUpdate(sessionId, { n: 4 });
    await phone.next((f) => isUpdateFrame(f) && f.seq === 4, "live seq 4");

    // Exactly the gap: seq 1 is not resent, 2 and 3 arrive once each, and the
    // live frame follows with no hole in between.
    expect(phone.frames.filter(isUpdateFrame).map((f) => f.seq)).toEqual([2, 3, 4]);
    expect(phone.frames.filter(isUpdateFrame).map((f) => f.update)).toEqual([
      { n: 2 },
      { n: 3 },
      { n: 4 },
    ]);
  });

  test("a second attach does not resend frames the socket already has", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");
    const sessionId = agent.acpSessionId ?? "";

    const stored = updateReaching(h, agent.id, 2);
    h.fake.emitUpdate(sessionId, { n: 1 });
    h.fake.emitUpdate(sessionId, { n: 2 });
    await stored;

    const phone = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    phone.send({ t: "attach", agentId: agent.id, sinceSeq: 0 });
    await phone.next((f) => isUpdateFrame(f) && f.seq === 2, "replayed seq 2");

    phone.send({ t: "attach", agentId: agent.id, sinceSeq: 0 });
    await barrier(phone, "second attach");

    expect(phone.frames.filter(isUpdateFrame).map((f) => f.seq)).toEqual([1, 2]);
  });

  test("updates reach only sockets attached to that agent", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");
    const sessionId = agent.acpSessionId ?? "";

    const watcher = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    watcher.send({ t: "attach", agentId: agent.id });
    await barrier(watcher, "watcher attach");

    const bystander = await openSocket(h.port, await h.pair("tablet", [SCOPE_READ]));
    await barrier(bystander, "bystander ready");

    h.fake.emitUpdate(sessionId, { n: 1 });
    await watcher.next(isUpdateFrame, "update on the attached socket");

    await barrier(bystander, "bystander drain");
    expect(bystander.frames.filter(isUpdateFrame)).toHaveLength(0);
  });

  test("detach stops the stream", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");
    const sessionId = agent.acpSessionId ?? "";

    const phone = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    phone.send({ t: "attach", agentId: agent.id });
    await barrier(phone, "attach");

    h.fake.emitUpdate(sessionId, { n: 1 });
    await phone.next((f) => isUpdateFrame(f) && f.seq === 1, "seq 1");

    phone.send({ t: "detach", agentId: agent.id });
    await barrier(phone, "detach");

    const stored = updateReaching(h, agent.id, 2);
    h.fake.emitUpdate(sessionId, { n: 2 });
    await stored;
    await barrier(phone, "drain after detach");

    expect(phone.frames.filter(isUpdateFrame).map((f) => f.seq)).toEqual([1]);
  });
});

describe("hostile frames", () => {
  test("malformed JSON produces an error and leaves the socket open", async () => {
    const h = await harness();
    const sock = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));

    sock.sendRaw("{not json");
    const error = await sock.next((f) => f.t === "error", "bad_json error");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("bad_json");

    // Still usable, which is the property that matters: a client mid-turn must
    // not lose its connection over one bad frame.
    await barrier(sock, "after malformed JSON");
  });

  test("an unknown frame type produces an error and leaves the socket open", async () => {
    const h = await harness();
    const sock = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));

    sock.sendRaw(JSON.stringify({ t: "teleport", agentId: "agt_whatever" }));
    const error = await sock.next((f) => f.t === "error", "unknown_frame error");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("unknown_frame");

    await barrier(sock, "after unknown frame");
  });

  test("a frame with no type produces an error and leaves the socket open", async () => {
    const h = await harness();
    const sock = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));

    sock.sendRaw(JSON.stringify({ agentId: "agt_whatever" }));
    const error = await sock.next((f) => f.t === "error", "unknown_frame error");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("unknown_frame");

    await barrier(sock, "after typeless frame");
  });

  test("attach without read scope is refused and streams nothing", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");

    const gadget = await openSocket(h.port, await h.pair("gadget", [SCOPE_PROMPT]));
    gadget.send({ t: "attach", agentId: agent.id });
    const error = await gadget.next((f) => f.t === "error", "attach refusal");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("unauthorized");

    const stored = updateReaching(h, agent.id, 1);
    h.fake.emitUpdate(agent.acpSessionId ?? "", { n: 1 });
    await stored;
    await barrier(gadget, "drain");
    expect(gadget.frames.filter(isUpdateFrame)).toHaveLength(0);
  });

  test("hello carries no agents for a socket without read scope", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    await createAgent(h, manage, "worker");

    const gadget = await openSocket(h.port, await h.pair("gadget", [SCOPE_PROMPT]));
    const hello = await gadget.next((f) => f.t === "hello", "hello");
    if (hello.t !== "hello") throw new Error("expected a hello frame");
    expect(hello.agents).toEqual([]);
  });

  test("a flood is rate limited and the socket survives it", async () => {
    const h = await harness();
    const sock = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    const flood = 200;

    for (let i = 0; i < flood; i += 1) sock.send({ t: "ping" });

    const answered = (): number =>
      sock.frames.filter((f) => f.t === "pong" || (f.t === "error" && f.code === "rate_limited"))
        .length;
    await sock.until(() => answered() >= flood, "every flood frame answered");

    const pongs = sock.frames.filter((f) => f.t === "pong").length;
    const limited = sock.frames.filter((f) => f.t === "error" && f.code === "rate_limited").length;

    expect(pongs + limited).toBe(flood);
    // The bucket engaged rather than passing everything through.
    expect(limited).toBeGreaterThan(0);
    // And the burst allowance was honoured rather than throttling from frame one.
    expect(pongs).toBeGreaterThanOrEqual(50);
    expect(pongs).toBeLessThan(flood);
  });

  test("audio without a voice bridge is reported, not silently dropped", async () => {
    const h = await harness();
    const manage = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE]);
    const agent = await createAgent(h, manage, "worker");

    const phone = await openSocket(h.port, await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]));
    phone.send({ t: "audio", agentId: agent.id, pcm: "AAAA" });
    const error = await phone.next((f) => f.t === "error", "voice error");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("voice_unavailable");
  });
});

describe("pending approvals on attach", () => {
  test("a client attaching to a blocked agent receives the approval", async () => {
    // The reconnect case. An approval is otherwise only ever pushed at the
    // moment it is raised, so a client that was not connected then sees an
    // agent sitting still with nothing to act on and no way to learn why.
    const h = await harness({ approvalTimeoutMs: 3000 });
    const operator = await h.pair("laptop", [
      SCOPE_READ,
      SCOPE_MANAGE,
      SCOPE_PROMPT,
      SCOPE_APPROVE,
    ]);
    const agent = await createAgent(h, operator, "worker");

    // Block the agent with nobody watching.
    const option = h.fake.requestPermission(agent.acpSessionId ?? "", bashCall("echo hi"));
    await waitForPending(h, agent.id);

    // Only now does a client turn up.
    const late = await openSocket(h.port, operator);
    late.send({ t: "attach", agentId: agent.id });

    const approval = await late.next((f) => f.t === "approval", "replayed approval");
    if (approval.t !== "approval") throw new Error("expected an approval frame");
    expect(approval.agentId).toBe(agent.id);
    expect(approval.tool).toBe("bash");
    expect(approval.title).toBe("echo hi");

    // Replay is worth nothing if the request it names is already dead, so the
    // decision has to still reach the agent.
    late.send({
      t: "decide",
      agentId: agent.id,
      requestId: approval.requestId,
      choice: "allow",
      scope: "once",
    });
    expect(await option).toBe("allow_once");
  });

  test("replay carries only the attached agent's approvals, and only once", async () => {
    const h = await harness({ approvalTimeoutMs: 3000 });
    const operator = await h.pair("laptop", [
      SCOPE_READ,
      SCOPE_MANAGE,
      SCOPE_PROMPT,
      SCOPE_APPROVE,
    ]);
    const mine = await createAgent(h, operator, "mine", "/work/mine");
    const other = await createAgent(h, operator, "other", "/work/other");

    const minePending = h.fake.requestPermission(mine.acpSessionId ?? "", bashCall("mine"));
    const otherPending = h.fake.requestPermission(other.acpSessionId ?? "", bashCall("other"));
    await waitForPending(h, mine.id);
    await waitForPending(h, other.id);

    const sock = await openSocket(h.port, operator);
    sock.send({ t: "attach", agentId: mine.id });
    await barrier(sock, "first attach");

    // A second attach must not duplicate an approval the socket already holds,
    // for the same reason `#deliverUpdate` has a high-water mark.
    sock.send({ t: "attach", agentId: mine.id });
    await barrier(sock, "second attach");

    const approvals = sock.frames.filter((f) => f.t === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.t === "approval" && approvals[0].agentId).toBe(mine.id);

    // Settled rather than left to time out, so the test costs no wall clock and
    // the teardown is not racing two live approval timers.
    for (const approval of h.sup.pendingApprovals()) {
      h.sup.decide(approval.requestId, "deny", "once", {
        deviceId: "daemon",
        scopes: [SCOPE_APPROVE],
      });
    }
    await Promise.all([minePending, otherPending]);
  });
});

describe("session modes", () => {
  test("config reports the mode selector the agent offered", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    const res = await h.http(`/v1/agents/${agent.id}/config`, {}, operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configOptions: Array<{ id: string; currentValue: string }> };
    const mode = body.configOptions.find((option) => option.id === "mode");
    expect(mode?.currentValue).toBe("default");
  });

  test("setting the mode reaches the agent and is reflected back", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    const res = await h.http(
      `/v1/agents/${agent.id}/config`,
      { method: "POST", body: JSON.stringify({ modeId: "plan" }) },
      operator,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configOptions: Array<{ id: string; currentValue: string }> };
    expect(body.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("plan");

    // The response is only worth anything if the agent actually moved. This is
    // the assertion on the far side of the wire.
    expect(h.fake.modeOf(agent.acpSessionId ?? "")).toBe("plan");

    // And a fresh read agrees, so the cache did not drift from the peer.
    const after = await h.http(`/v1/agents/${agent.id}/config`, {}, operator);
    const seen = (await after.json()) as { configOptions: Array<{ id: string; currentValue: string }> };
    expect(seen.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("plan");
  });

  test("a mode the session never offered is refused before it reaches the agent", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    const res = await h.http(
      `/v1/agents/${agent.id}/config`,
      { method: "POST", body: JSON.stringify({ modeId: "yolo" }) },
      operator,
    );
    expect(res.status).toBe(400);
    expect(h.fake.modeOf(agent.acpSessionId ?? "")).toBe("default");
  });

  test("reading the mode needs read and setting it needs prompt", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");
    const readOnly = await h.pair("phone", [SCOPE_READ]);

    expect((await h.http(`/v1/agents/${agent.id}/config`, {}, readOnly)).status).toBe(200);

    // `plan` is the read-only mode, so leaving it widens what the agent may do.
    // A device that can only watch must not be able to authorise that.
    const denied = await h.http(
      `/v1/agents/${agent.id}/config`,
      { method: "POST", body: JSON.stringify({ modeId: "plan" }) },
      readOnly,
    );
    expect(denied.status).toBe(403);
    expect(h.fake.modeOf(agent.acpSessionId ?? "")).toBe("default");
  });

  test("config for an unknown agent is a 404", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    expect((await h.http("/v1/agents/agt_nope/config", {}, operator)).status).toBe(404);
  });
});

describe("cancel", () => {
  test("a cancel mid-turn settles the turn", async () => {
    // A cancel that only records intent and lets the turn run to completion is
    // indistinguishable from a working one until the model keeps talking. The
    // assertion is therefore on the stop reason the prompt resolved with.
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    // A turn that never ends on its own, so only a cancel can settle it.
    const started = Promise.withResolvers<void>();
    h.fake.onPrompt(() => {
      started.resolve();
      return new Promise<unknown>(() => {});
    });

    const sock = await openSocket(h.port, operator);
    sock.send({ t: "attach", agentId: agent.id });
    await barrier(sock, "attach");

    const turn = h.sup.prompt(agent.id, "think forever", {
      deviceId: "daemon",
      scopes: [SCOPE_PROMPT],
    });
    await started.promise;

    sock.send({ t: "cancel", agentId: agent.id });

    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    expect(h.fake.cancels).toContain(agent.acpSessionId ?? "");
  });

  test("cancel needs prompt scope and never reaches the agent without it", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    const readOnly = await openSocket(h.port, await h.pair("phone", [SCOPE_READ]));
    readOnly.send({ t: "attach", agentId: agent.id });
    readOnly.send({ t: "cancel", agentId: agent.id });

    const error = await readOnly.next((f) => f.t === "error", "cancel refusal");
    if (error.t !== "error") throw new Error("expected an error frame");
    expect(error.code).toBe("unauthorized");
    expect(h.fake.cancels).toHaveLength(0);
  });
});

describe("prompt over http", () => {
  test("the route returns the stop reason the agent settled with", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");
    h.fake.onPrompt(() => ({ stopReason: "end_turn" }));

    const res = await h.http(
      `/v1/agents/${agent.id}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "hello" }) },
      operator,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentId: agent.id, stopReason: "end_turn" });
    expect(h.fake.prompts.at(-1)?.text).toBe("hello");
  });

  test("the route enforces prompt scope and sends nothing without it", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");
    const readOnly = await h.pair("phone", [SCOPE_READ]);

    const res = await h.http(
      `/v1/agents/${agent.id}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "do the thing" }) },
      readOnly,
    );
    expect(res.status).toBe(403);
    // The refusal has to mean the turn never happened, not that the response
    // was discarded after the agent already acted on it.
    expect(h.fake.prompts).toHaveLength(0);
  });

  test("an empty prompt is refused and an unknown agent is a 404", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await createAgent(h, operator, "worker");

    const empty = await h.http(
      `/v1/agents/${agent.id}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "" }) },
      operator,
    );
    expect(empty.status).toBe(400);

    const missing = await h.http(
      "/v1/agents/agt_nope/prompt",
      { method: "POST", body: JSON.stringify({ text: "hi" }) },
      operator,
    );
    expect(missing.status).toBe(404);
    expect(h.fake.prompts).toHaveLength(0);
  });
});
