import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCOPE_MANAGE, Store, type Actor } from "@ompd/core";
import { parseAgentRegistryNotification } from "@ompd/acp";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const supervisors: Supervisor[] = [];

function manager(store: Store): Actor {
  const actor = { deviceId: "operator", scopes: [SCOPE_MANAGE] };
  store.addDevice({
    id: actor.deviceId,
    name: "operator",
    publicKey: "pk_operator",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  return actor;
}

afterEach(async () => {
  while (supervisors.length > 0) await supervisors.pop()?.shutdown();
  while (stores.length > 0) stores.pop()?.close();
  while (paths.length > 0) rmSync(paths.pop() ?? "", { force: true });
});

describe("Agent Hub registry mirroring", () => {
  test("persists child lineage, assignment, model, status, and streaming metrics", async () => {
    const path = `/tmp/ompd-agent-hub-${crypto.randomUUID()}.db`;
    paths.push(path);
    const store = new Store(path);
    stores.push(store);
    const fake = createFakeHost();
    const supervisor = new Supervisor({ store, spawnHost: fake.factory });
    supervisors.push(supervisor);
    const parent = await supervisor.createAgent({ name: "primary", cwd: "/tmp" }, manager(store));
    const now = new Date().toISOString();

    fake.emitAgentRegistry([
      {
        id: "Main",
        displayName: "primary",
        kind: "main",
        status: "idle",
        createdAt: now,
        lastActiveAt: now,
      },
      {
        id: "PolicyScout",
        displayName: "Policy Scout",
        kind: "sub",
        parentId: "Main",
        parentSessionId: parent.acpSessionId,
        sessionId: "sub_sess_1",
        status: "running",
        createdAt: now,
        lastActiveAt: now,
        taskTitle: "Inspect the permission path",
        model: "anthropic/claude-sonnet-5",
        metrics: { usedTokens: 1_200, costAmount: 0.0175, durationMs: 65_000 },
      },
    ]);
    expect(
      parseAgentRegistryNotification({
        agents: [
          {
            id: "Main",
            displayName: "primary",
            kind: "main",
            status: "idle",
            createdAt: now,
            lastActiveAt: now,
          },
        ],
      }),
    ).not.toBeUndefined();
    await Bun.sleep(0);

    const child = supervisor.listAgents().find((agent) => agent.parentAgentId === parent.id);
    expect(child).toMatchObject({
      name: "Policy Scout",
      parentAgentId: parent.id,
      taskTitle: "Inspect the permission path",
      model: "anthropic/claude-sonnet-5",
      state: "busy",
      metrics: { usedTokens: 1_200, costAmount: 0.0175, durationMs: 65_000 },
    });

    fake.emitAgentRegistry([
      {
        id: "Main",
        displayName: "primary",
        kind: "main",
        status: "idle",
        createdAt: now,
        lastActiveAt: now,
      },
      {
        id: "PolicyScout",
        displayName: "Policy Scout",
        kind: "sub",
        parentId: "Main",
        parentSessionId: parent.acpSessionId,
        sessionId: "sub_sess_1",
        status: "parked",
        createdAt: now,
        lastActiveAt: now,
        taskTitle: "Inspect the permission path",
        model: "anthropic/claude-sonnet-5",
        metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
      },
    ]);
    await Bun.sleep(0);

    expect(store.getAgent(child?.id ?? "")).toMatchObject({
      state: "stopped",
      metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
    });
  });
});
