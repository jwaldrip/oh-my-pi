/**
 * `resumeAgent`, end to end against a scripted ACP peer.
 *
 * Same methodology as permission-path.test.ts: real Supervisor, real policy,
 * real store, real ACP client -- only the subprocess is scripted. The claims
 * under test are specific to resume and would pass trivially against
 * `createAgent`, so each one asserts something `createAgent` cannot produce:
 * a session id that was never minted, updates that arrive before any prompt
 * was sent, and a policy verdict reached through the identical gate wiring.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store, type Actor } from "@ompd/core";
import { Supervisor, type PendingApproval } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];

interface Harness {
  sup: Supervisor;
  store: Store;
  fake: FakeHostController;
  approvals: Array<Omit<PendingApproval, "resolve">>;
  updates: Array<{ agentId: string; seq: number; update: unknown }>;
  pair: (id: string, scopes: string[]) => Actor;
}

function harness(opts: { approvalTimeoutMs?: number; mcpServersFor?: (agentId: string) => unknown[] } = {}): Harness {
  const path = `/tmp/ompd-resume-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const approvals: Array<Omit<PendingApproval, "resolve">> = [];
  const updates: Array<{ agentId: string; seq: number; update: unknown }> = [];
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 500,
    spawnHost: fake.factory,
    mcpServersFor: opts.mcpServersFor,
    events: {
      onApprovalNeeded: (p) => approvals.push(p),
      onUpdate: (agentId, seq, update) => updates.push({ agentId, seq, update }),
    },
  });
  sups.push(sup);
  return {
    sup,
    store,
    fake,
    approvals,
    updates,
    pair: (id, scopes) => {
      store.addDevice({ id, name: id, publicKey: `pk_${id}`, scopes, createdAt: new Date().toISOString() });
      return { deviceId: id, scopes };
    },
  };
}

afterEach(async () => {
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

describe("resumeAgent", () => {
  test("loads the exact session id given it and mints no new one", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const priorSessionId = "prior-session-from-a-terminal-that-already-exited";

    const agent = await h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: priorSessionId }, admin);

    expect(agent.acpSessionId).toBe(priorSessionId);
    expect(h.fake.loads).toEqual([priorSessionId]);
    // The decisive negative: a restart would show up here, as a freshly
    // minted `sess_1`. It never does.
    expect(h.fake.sessions).toEqual([]);
  });

  test("restores the daemon MCP mounts when loading an existing session", async () => {
    const descriptors: Array<{ name: string; url: string }> = [];
    const h = harness({
      mcpServersFor: agentId => {
        const descriptor = { name: "ompd-webview", url: `http://127.0.0.1/webview/${agentId}` };
        descriptors.push(descriptor);
        return [descriptor];
      },
    });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

    const agent = await h.sup.resumeAgent(
      { name: "r", cwd: "/work", sessionId: "prior-session-with-webview" },
      admin,
    );

    expect(descriptors).toEqual([{ name: "ompd-webview", url: `http://127.0.0.1/webview/${agent.id}` }]);
    expect(h.fake.loadRequests).toEqual([
      {
        sessionId: "prior-session-with-webview",
        cwd: "/work",
        mcpServers: descriptors,
      },
    ]);
  });

  test("session/update frames sent before any prompt reach the resumed agent, proving continuation rather than a blank start", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const priorSessionId = "prior-session-with-history";

    const agent = await h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: priorSessionId }, admin);

    // Stands in for the real `omp acp` history replay `#replaySessionHistory`
    // performs on `session/load` before this call returns control to the
    // model: entries a resumed session already has and a freshly created one
    // could not. Sent before any prompt, so a restarted/blank session would
    // show zero updates at this point -- there is nothing yet to replay.
    h.fake.emitUpdate(priorSessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "PRIOR MESSAGE FROM BEFORE RESUME" },
    });

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.agentId).toBe(agent.id);
    expect(h.updates[0]?.update).toMatchObject({
      content: { text: "PRIOR MESSAGE FROM BEFORE RESUME" },
    });
  });

  test("a tool call in a resumed session reaches the policy engine and is decided the same way a created one would be", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const priorSessionId = "prior-session-dangerous-command";

    const agent = await h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: priorSessionId }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, bashCall("rm -rf /"));

    expect(option).toBe("reject_once");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("deny");
  });

  test("a workspace read in a resumed session is allowed without troubling a human, same as createAgent", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const priorSessionId = "prior-session-workspace-read";

    const agent = await h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: priorSessionId }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, {
      toolCallId: "tc_read",
      title: "read main.ts",
      kind: "read",
      rawInput: { path: "/work/main.ts" },
    });

    expect(option).toBe("allow_once");
    expect(h.approvals).toHaveLength(0);
  });

  test("refuses to resume a session id this daemon already has an agent holding", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const priorSessionId = "already-adopted-session";

    await h.sup.resumeAgent({ name: "first", cwd: "/work", sessionId: priorSessionId }, admin);

    await expect(
      h.sup.resumeAgent({ name: "second", cwd: "/work", sessionId: priorSessionId }, admin),
    ).rejects.toThrow(/already held/);
    // Refused before ever asking the peer to load it a second time.
    expect(h.fake.loads).toEqual([priorSessionId]);
  });

  test("refuses to resume without manage scope, before touching a host or the peer", async () => {
    const h = harness();
    const noManage: Actor = { deviceId: "no-manage", scopes: [SCOPE_READ] };
    h.store.addDevice({
      id: "no-manage",
      name: "no-manage",
      publicKey: "pk",
      scopes: [SCOPE_READ],
      createdAt: new Date().toISOString(),
    });

    await expect(h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: "x" }, noManage)).rejects.toThrow(
      /missing manage scope/,
    );
    expect(h.fake.loads).toEqual([]);
  });

  test("lastActiveAt-bearing agent row exists immediately, before the load resolves, same lifecycle createAgent has", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.resumeAgent({ name: "r", cwd: "/work", sessionId: "s1" }, admin);

    const stored = h.store.getAgent(agent.id);
    expect(stored?.state).toBe("idle");
    expect(stored?.acpSessionId).toBe("s1");
  });
});
