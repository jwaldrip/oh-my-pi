import { afterEach, describe, expect, test, vi } from "bun:test";
import { rmSync } from "node:fs";
import {
  DefaultPolicy,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  Store,
  type Agent,
  type AgentId,
  type QueuedIntent,
} from "@ompd/core";
import { Gateway } from "../src/gateway/gateway.ts";
import { HttpIntentPeer, QueuedIntentDrainer } from "../src/federation/queued-intents.ts";
import { Supervisor, createAgentId } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const supervisors: Supervisor[] = [];

interface GatewayHarness {
  gateway: Gateway;
  store: Store;
  supervisor: Supervisor;
  fake: FakeHostController;
  baseUrl: string;
  pair(scopes: string[]): Promise<string>;
  request(path: string, init: RequestInit, token?: string): Promise<Response>;
}

function replicaAgent(id: AgentId): Agent {
  const now = new Date().toISOString();
  return {
    id,
    name: "Mirrored agent",
    state: "idle",
    host: { kind: "local", id: "delegate", spec: { kind: "local" } },
    cwd: "/workspace",
    createdAt: now,
    lastActiveAt: now,
    labels: {},
  };
}

async function makeGateway(opts: { replica?: boolean; syncToken?: string } = {}): Promise<GatewayHarness> {
  const path = `/tmp/ompd-queued-intents-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const supervisor = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: fake.factory,
  });
  supervisors.push(supervisor);
  const gateway = new Gateway({
    supervisor,
    store,
    port: 0,
    federation:
      opts.syncToken === undefined
        ? undefined
        : { replica: opts.replica ?? false, syncToken: opts.syncToken },
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    gateway,
    store,
    supervisor,
    fake,
    baseUrl,
    pair: async (scopes) => {
      const paired = await fetch(`${baseUrl}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "operator", publicKey: "pk_operator" }),
      });
      const body = (await paired.json()) as { code: string };
      return gateway.approvePairing(body.code, scopes);
    },
    request: (path, init, token) => {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
  };
}

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()));
  await Promise.all(supervisors.map((supervisor) => supervisor.shutdown()));
  for (const store of stores) store.close();
  for (const path of paths) rmSync(path, { force: true });
  gateways.length = 0;
  supervisors.length = 0;
  stores.length = 0;
  paths.length = 0;
});

describe("Federation queued intents", () => {
  test("a replica queues authorized writes for an agent it does not own", async () => {
    const cloud = await makeGateway({ replica: true, syncToken: "cloud-sync-token" });
    const operator = await cloud.pair([SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agentId = createAgentId();
    cloud.store.upsertAgent(replicaAgent(agentId));

    const prompt = await cloud.request(
      `/v1/agents/${agentId}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "Review the change" }) },
      operator,
    );
    expect(prompt.status).toBe(202);
    expect(cloud.fake.prompts).toEqual([]);

    const tunnel = cloud.gateway.acceptTunnelSession(operator, () => {});
    expect(tunnel.ok).toBeTrue();
    if (!tunnel.ok) throw new Error("paired operator should open the tunnel session");
    tunnel.deliver(JSON.stringify({ t: "cancel", agentId }));
    tunnel.deliver(
      JSON.stringify({ t: "decide", agentId, requestId: "apr_remote", choice: "allow", scope: "once" }),
    );

    const created = await cloud.request(
      "/v1/agents",
      { method: "POST", body: JSON.stringify({ name: "Queued agent", cwd: "/workspace" }) },
      operator,
    );
    expect(created.status).toBe(202);
    expect(cloud.fake.sessions).toEqual([]);

    const pending = cloud.store.listPendingQueuedIntents();
    expect(pending.map((intent) => intent.action).toSorted()).toEqual([
      "cancel",
      "decide",
      "new-agent",
      "prompt",
    ]);
    expect(pending.filter((intent) => intent.action !== "new-agent").every((intent) => intent.agentId === agentId)).toBeTrue();
    expect(pending.every((intent) => intent.actorDeviceId !== "daemon")).toBeTrue();
  });

  test("the owning delegate pulls, executes, and acknowledges queued intents", async () => {
    const cloud = await makeGateway({ replica: true, syncToken: "cloud-sync-token" });
    const operator = await cloud.pair([SCOPE_PROMPT, SCOPE_MANAGE]);
    const local = await makeGateway();
    const agentId = createAgentId();
    cloud.store.upsertAgent(replicaAgent(agentId));
    await local.supervisor.createAgent(
      { id: agentId, name: "Local delegate", cwd: "/workspace" },
      { deviceId: "daemon", scopes: [SCOPE_MANAGE] },
    );

    const queued = await cloud.request(
      `/v1/agents/${agentId}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "Execute this locally" }) },
      operator,
    );
    expect(queued.status).toBe(202);

    const peer = new HttpIntentPeer({ url: cloud.baseUrl, token: "cloud-sync-token" });
    const drainer = new QueuedIntentDrainer({ supervisor: local.supervisor, peer });
    expect(await drainer.drain()).toBe(1);
    expect(local.fake.prompts).toHaveLength(1);
    expect(local.fake.prompts[0]?.text).toBe("Execute this locally");

    const pending = await cloud.request("/v1/sync/intents", { method: "GET" }, "cloud-sync-token");
    expect(pending.status).toBe(200);
    expect((await pending.json()) as { intents: QueuedIntent[] }).toEqual({ intents: [] });
  });

  test("periodically drains the replica queue until the delegate stops", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    await local.supervisor.createAgent(
      { id: agentId, name: "Local delegate", cwd: "/workspace" },
      { deviceId: "daemon", scopes: [SCOPE_MANAGE] },
    );
    const acknowledged = Promise.withResolvers<void>();
    let pending = true;
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      peer: {
        pullPendingIntents: async () =>
          pending
            ? [
                {
                  id: "qi_periodic",
                  agentId,
                  actorDeviceId: "dev_cloud_operator",
                  action: "prompt",
                  payload: { text: "Poll the replica" },
                  createdAt: new Date().toISOString(),
                  status: "pending",
                },
              ]
            : [],
        acknowledgeDelivered: async (ids) => {
          expect(ids).toEqual(["qi_periodic"]);
          pending = false;
          acknowledged.resolve();
        },
      },
    });
    local.fake.onPrompt((_sessionId, text) => {
      expect(text).toBe("Poll the replica");
    });
    vi.useFakeTimers();
    drainer.start(1);
    try {
      vi.advanceTimersByTime(1);
      await acknowledged.promise;
      expect(pending).toBeFalse();
    } finally {
      drainer.stop();
      vi.useRealTimers();
    }
  });

  test("the delegate preserves a reserved agent id when it drains a queued creation", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    const intent: QueuedIntent = {
      id: "qi_new_agent",
      agentId,
      actorDeviceId: "dev_cloud_operator",
      action: "new-agent",
      payload: { name: "Created by delegate", cwd: "/workspace" },
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const acknowledged: string[][] = [];
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      peer: {
        pullPendingIntents: async () => [intent],
        acknowledgeDelivered: async (ids) => void acknowledged.push([...ids]),
      },
    });

    expect(await drainer.drain()).toBe(1);
    expect(local.supervisor.listAgents().map((agent) => agent.id)).toContain(agentId);
    expect(acknowledged).toEqual([[intent.id]]);
  });
});
