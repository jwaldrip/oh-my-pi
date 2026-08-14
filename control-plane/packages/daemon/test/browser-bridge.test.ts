/**
 * `WebViewBridge`: the policy gate for a WebView action, and the message
 * bridge's refusal to let page content become one.
 *
 * The two claims `docs/browser.md` makes under "the agent to act in it":
 *
 *  1. An action reaches the policy engine before it reaches a device --
 *     proven here by spying on `dispatch.send` and showing it is called if
 *     and only if the policy said `allow`.
 *  2. Page content can only ever become data, never an instruction -- proven
 *     in `browser-mcp.test.ts` (the tool-call boundary) and in
 *     `app/test/browser-bridge.test.ts` (the in-app message parser).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DefaultPolicy,
  Store,
  type Agent,
  type Policy,
  type PolicyContext,
  type PolicyDecision,
  type WebViewAction,
} from "@ompd/core";
import {
  NO_RESPONSE,
  NO_TARGET,
  PROMPT_NOT_WIRED,
  WebViewBridge,
  type WebViewApprovalGate,
  type WebViewDispatch,
} from "../src/browser/bridge.ts";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function harness(policy: Policy, available = true, approvals?: WebViewApprovalGate) {
  const path = `/tmp/ompd-webview-bridge-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  const agent: Agent = {
    id: "agt_0000000000000001",
    name: "test",
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/tmp/ws",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    labels: {},
  };
  store.upsertAgent(agent);

  const sent: Array<{ agentId: string; requestId: string; action: WebViewAction }> = [];
  const dispatch: WebViewDispatch = {
    send: (agentId, requestId, action) => {
      sent.push({ agentId, requestId, action });
      return available;
    },
  };
  const bridge = new WebViewBridge({ policy, store, dispatch, approvals, timeoutMs: 200 });
  return { bridge, sent, agentId: agent.id };
}

/** A policy that always answers the same way, ignoring the call entirely -- proves the bridge does not hard-code a verdict of its own. */
function fixedPolicy(action: PolicyDecision["action"]): Policy {
  return {
    evaluate(_ctx: PolicyContext): PolicyDecision {
      return { action, reason: "fixed for test", rule: "fixed" };
    },
  };
}

describe("WebViewBridge: an action reaches the policy engine", () => {
  test("a denying policy stops navigate before any frame reaches a device", async () => {
    const { bridge, sent, agentId } = harness(fixedPolicy("deny"));
    const result = await bridge.performAction(agentId, { kind: "navigate", url: "https://example.com" });
    expect(result).toEqual({ kind: "error", message: "denied: fixed for test" });
    expect(sent).toEqual([]);
  });
  test("an allowing policy on the identical call does reach the device", async () => {
    const { bridge, sent, agentId } = harness(fixedPolicy("allow"));
    const pending = bridge.performAction(agentId, { kind: "navigate", url: "https://example.com" });
    // The action dispatched synchronously to `sent` before the promise settles.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toEqual({ kind: "navigate", url: "https://example.com" });
    bridge.resolveResult(agentId, sent[0]!.requestId, { kind: "ack", url: "https://example.com", title: "Example" });
    await expect(pending).resolves.toEqual({ kind: "ack", url: "https://example.com", title: "Example" });
  });

  test("an allowed action with no registered target fails immediately", async () => {
    const { bridge, agentId } = harness(fixedPolicy("allow"), false);
    await expect(bridge.performAction(agentId, { kind: "observe" })).resolves.toEqual({
      kind: "error",
      message: NO_TARGET,
    });
  });

  test("a `prompt` verdict fails closed with a distinct reason, and never reaches a device", async () => {
    const { bridge, sent, agentId } = harness(fixedPolicy("prompt"));
    const result = await bridge.performAction(agentId, { kind: "click", ref: "n3" });
    expect(result).toEqual({ kind: "error", message: PROMPT_NOT_WIRED });
    expect(sent).toEqual([]);
  });

  test("a prompted navigate asks the gate and dispatches the exact approved action", async () => {
    const asked: Parameters<WebViewApprovalGate["request"]>[0][] = [];
    const approvals: WebViewApprovalGate = {
      request: (input) => {
        asked.push(input);
        return Promise.resolve({ allowed: true, reason: "approved once" });
      },
    };
    const { bridge, sent, agentId } = harness(fixedPolicy("prompt"), true, approvals);
    const action = { kind: "navigate" as const, url: "https://example.com/path" };
    const pending = bridge.performAction(agentId, action);
    await Promise.resolve();

    expect(asked).toEqual([
      {
        agentId,
        tool: "webview_navigate",
        title: "Navigate to https://example.com/path",
        action,
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toEqual(action);
    bridge.resolveResult(agentId, sent[0]!.requestId, {
      kind: "ack",
      url: action.url,
      title: "Example",
    });
    await expect(pending).resolves.toMatchObject({ kind: "ack", url: action.url });
  });

  test("a gate refusal carries its reason and never dispatches", async () => {
    const asked: Parameters<WebViewApprovalGate["request"]>[0][] = [];
    const approvals: WebViewApprovalGate = {
      request: (input) => {
        asked.push(input);
        return Promise.resolve({ allowed: false, reason: "operator denied this click" });
      },
    };
    const { bridge, sent, agentId } = harness(fixedPolicy("prompt"), true, approvals);
    const action = { kind: "click" as const, ref: "n3" };

    await expect(bridge.performAction(agentId, action)).resolves.toEqual({
      kind: "error",
      message: "operator denied this click",
    });
    expect(asked).toEqual([
      { agentId, tool: "webview_click", title: "Click n3", action },
    ]);
    expect(sent).toEqual([]);
  });

  test("a type approval title names the ref and text", async () => {
    const asked: Parameters<WebViewApprovalGate["request"]>[0][] = [];
    const approvals: WebViewApprovalGate = {
      request: (input) => {
        asked.push(input);
        return Promise.resolve({ allowed: false, reason: "operator denied typing" });
      },
    };
    const { bridge, sent, agentId } = harness(fixedPolicy("prompt"), true, approvals);
    const action = { kind: "type" as const, ref: "n4", text: "hello world" };

    await bridge.performAction(agentId, action);
    expect(asked).toEqual([
      {
        agentId,
        tool: "webview_type",
        title: 'Type "hello world" into n4',
        action,
      },
    ]);
    expect(sent).toEqual([]);
  });

  test("observe bypasses the approval gate", async () => {
    let asks = 0;
    const approvals: WebViewApprovalGate = {
      request: () => {
        asks += 1;
        return Promise.resolve({ allowed: false, reason: "must not be asked" });
      },
    };
    const { bridge, sent, agentId } = harness(fixedPolicy("allow"), true, approvals);
    const pending = bridge.performAction(agentId, { kind: "observe" });
    expect(asks).toBe(0);
    expect(sent).toHaveLength(1);
    bridge.resolveResult(agentId, sent[0]!.requestId, {
      kind: "observe",
      observation: {
        url: "about:blank",
        title: "",
        settled: true,
        tree: { tag: "body", ref: "n0" },
      },
    });
    await expect(pending).resolves.toMatchObject({ kind: "observe" });
  });

  test.each([
    ["file URL", "file:///etc/passwd"],
    ["OS-handled URL", "tel:+15551234567"],
    ["script URL", "javascript:alert(1)"],
    ["URL without a host", "https://"],
  ])("refuses a %s before policy, approval, or dispatch", async (_class, url) => {
    let evaluated = false;
    let asks = 0;
    const policy: Policy = {
      evaluate() {
        evaluated = true;
        return { action: "prompt", reason: "must not run", rule: "test" };
      },
    };
    const approvals: WebViewApprovalGate = {
      request: () => {
        asks += 1;
        return Promise.resolve({ allowed: true, reason: "must not run" });
      },
    };
    const { bridge, sent, agentId } = harness(policy, true, approvals);

    const result = await bridge.performAction(agentId, { kind: "navigate", url });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unsafe navigation unexpectedly dispatched");
    expect(result.message).toContain(url);
    expect(evaluated).toBe(false);
    expect(asks).toBe(0);
    expect(sent).toEqual([]);
  });

  test("DefaultPolicy's real rules: webview_observe fast-paths allow, webview_navigate does not", async () => {
    const { bridge: obsBridge, sent: obsSent, agentId: obsAgent } = harness(new DefaultPolicy({ mode: "standard" }));
    const observePending = obsBridge.performAction(obsAgent, { kind: "observe" });
    expect(obsSent).toHaveLength(1);
    obsBridge.resolveResult(obsAgent, obsSent[0]!.requestId, {
      kind: "observe",
      observation: { url: "https://example.com", title: "Example", settled: true, tree: { tag: "body", ref: "n0" } },
    });
    await expect(observePending).resolves.toMatchObject({ kind: "observe" });

    const { bridge: navBridge, sent: navSent, agentId: navAgent } = harness(new DefaultPolicy({ mode: "standard" }));
    const navResult = await navBridge.performAction(navAgent, { kind: "navigate", url: "https://example.com" });
    expect(navResult).toEqual({ kind: "error", message: PROMPT_NOT_WIRED });
    expect(navSent).toEqual([]);
  });

  test("a device that never answers times out rather than hanging the caller forever", async () => {
    const { bridge, agentId } = harness(fixedPolicy("allow"));
    const result = await bridge.performAction(agentId, { kind: "screenshot" });
    expect(result).toEqual({ kind: "error", message: NO_RESPONSE });
  });

  test("resolveResult rejects the wrong agent, an unknown id, and an already-settled id", async () => {
    const { bridge, sent, agentId } = harness(fixedPolicy("allow"));
    const pending = bridge.performAction(agentId, { kind: "observe" });
    const requestId = sent[0]!.requestId;
    expect(bridge.resolveResult("agt_other", requestId, { kind: "ack", url: "x", title: "x" })).toBe(false);
    expect(bridge.resolveResult(agentId, requestId, { kind: "ack", url: "x", title: "x" })).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "ack", url: "x", title: "x" });
    expect(bridge.resolveResult(agentId, requestId, { kind: "ack", url: "x", title: "x" })).toBe(false);
    expect(bridge.resolveResult(agentId, "wv_doesnotexist", { kind: "ack", url: "x", title: "x" })).toBe(false);
  });

  test("an unknown agent id is refused before the policy is even consulted", async () => {
    let evaluated = false;
    const policy: Policy = {
      evaluate() {
        evaluated = true;
        return { action: "allow", reason: "should not run", rule: "test" };
      },
    };
    const { bridge, sent } = harness(policy);
    const result = await bridge.performAction("agt_doesnotexist", { kind: "observe" });
    expect(result).toEqual({ kind: "error", message: "no such agent: agt_doesnotexist" });
    expect(evaluated).toBe(false);
    expect(sent).toEqual([]);
  });
});
