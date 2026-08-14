/**
 * The daemon-side proof for two of this assignment's acceptance criteria:
 * task routes carry the scopes they claim to, and a task's prompt -- whether
 * or not it names a skill -- reaches the exact same policy gate any other
 * prompt does.
 *
 * Structured like `permission-path.test.ts`: real `Supervisor`, real
 * `DefaultPolicy`, real `Store`, real `Gateway`, and a scripted ACP peer for
 * the subprocess. The only thing under test that is new here is
 * `POST /v1/tasks`; everything downstream of `Supervisor.prompt` is the
 * identical, already-covered permission path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store, type Agent } from "@ompd/core";
import { Supervisor } from "../src/supervisor.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { TaskManager } from "../src/workspace/tasks.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];
const gateways: Gateway[] = [];

interface Harness {
  store: Store;
  fake: FakeHostController;
  base: string;
  pair: (name: string, scopes: string[]) => Promise<string>;
  http: (path: string, init?: RequestInit, token?: string) => Promise<Response>;
  /** Creates an agent through the real HTTP route and returns it, parsed once. */
  createAgent: (token: string) => Promise<Agent>;
}

interface CreateAgentResponse {
  agent: Agent;
}

async function harness(opts: { approvalTimeoutMs?: number } = {}): Promise<Harness> {
  const path = `/tmp/ompd-tasks-policy-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 300,
    spawnHost: hosts.spawn,
    events,
  });
  sups.push(sup);

  const tasks = new TaskManager({ store, supervisor: sup });
  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, tasks });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  const http = (routePath: string, init: RequestInit = {}, token?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${routePath}`, { ...init, headers });
  };

  return {
    store,
    fake,
    base,
    pair: async (name, scopes) => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${name}` }),
      });
      const parsed = (await res.json()) as { code?: unknown };
      if (typeof parsed.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(parsed.code, scopes);
    },
    http,
    createAgent: async (token) => {
      const res = await http(
        "/v1/agents",
        { method: "POST", body: JSON.stringify({ name: "a", cwd: "/work" }) },
        token,
      );
      const parsed = (await res.json()) as CreateAgentResponse;
      return parsed.agent;
    },
  };
}

afterEach(async () => {
  while (gateways.length) await gateways.pop()?.close();
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

const bashCall = (command: string) => ({
  toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
  title: command,
  kind: "execute",
  rawInput: { command },
});

describe("POST /v1/tasks and the policy engine", () => {
  test("a task started from a skill reaches the exact same policy gate a plain prompt does", async () => {
    const h = await harness({ approvalTimeoutMs: 300 });
    const admin = await h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]);
    const agent = await h.createAgent(admin);
    const sessionId = agent.acpSessionId;
    if (sessionId === undefined) throw new Error("test agent has no acp session");

    // The turn the task's prompt drives asks for a tool the way a real one
    // would mid-stream. Nobody holds `approve`, so the policy engine's own
    // fail-closed timeout is what has to answer it -- if task creation ran
    // the prompt through anything other than `Supervisor.prompt`, this
    // request would never arrive at all.
    const permissionSeen = Promise.withResolvers<string>();
    h.fake.onPrompt(async (sessionId) => {
      const option = await h.fake.requestPermission(sessionId, bashCall("touch /tmp/from-a-skill"));
      permissionSeen.resolve(option);
      return { stopReason: "end_turn" };
    });

    const res = await h.http(
      "/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Run a skill",
          prompt: "/skill:touch-file do the thing",
          agentId: agent.id,
          skillName: "touch-file",
        }),
      },
      admin,
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { task: { id: string; state: string; skillName?: string } };
    expect(created.task.skillName).toBe("touch-file");

    const seenOption = await permissionSeen.promise;
    expect(seenOption).toBe("reject_once");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("deny");
    expect(rec?.rule).toBe("timeout");

    // The prompt the fake peer actually received is the exact text the task
    // named -- nothing rewrote or intercepted it on the way through.
    expect(h.fake.prompts.at(-1)).toEqual({
      sessionId,
      text: "/skill:touch-file do the thing",
    });
  });

  test("POST /v1/tasks requires prompt scope; read alone is refused", async () => {
    const h = await harness();
    const admin = await h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]);
    const readOnly = await h.pair("viewer", [SCOPE_READ]);
    const agent = await h.createAgent(admin);

    const res = await h.http(
      "/v1/tasks",
      { method: "POST", body: JSON.stringify({ title: "t", prompt: "p", agentId: agent.id }) },
      readOnly,
    );
    expect(res.status).toBe(403);
  });

  test("GET /v1/tasks and GET /v1/tasks/:id require read scope; a device with neither scope is refused both", async () => {
    const h = await harness();
    const nothing = await h.pair("stranger", []);

    expect((await h.http("/v1/tasks", {}, nothing)).status).toBe(403);
    expect((await h.http("/v1/tasks/tsk_x", {}, nothing)).status).toBe(403);
  });

  test("POST /v1/tasks refuses an unknown agent id with 404, not a silently created one", async () => {
    const h = await harness();
    const admin = await h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]);

    const res = await h.http(
      "/v1/tasks",
      { method: "POST", body: JSON.stringify({ title: "t", prompt: "p", agentId: "agt_does_not_exist" }) },
      admin,
    );
    expect(res.status).toBe(404);
    expect(h.store.listTasks()).toHaveLength(0);
  });

  test("every task/skill/connector route is unreachable without a bearer token at all", async () => {
    const h = await harness();
    expect((await h.http("/v1/tasks")).status).toBe(401);
    expect((await h.http("/v1/skills")).status).toBe(401);
    expect((await h.http("/v1/connectors")).status).toBe(401);
    expect((await h.http("/v1/tasks", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
