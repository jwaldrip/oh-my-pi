/**
 * The MCP-over-HTTP boundary a real `omp acp` session would call through.
 *
 * A real JSON-RPC client, a real `Bun.serve` instance, real HTTP -- only the
 * "device" behind `WebViewBridge` is a stub, for the same reason
 * `fake-host.ts` scripts the ACP peer rather than spawning a real one: the
 * thing under test is the wiring, not a model's or a device's behaviour. The
 * stub answers synchronously from inside `dispatch.send`, so no test here
 * waits on a real clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, Store, type Agent, type WebViewAction, type WebViewActionResult } from "@ompd/core";
import { WebViewBridge, type WebViewDispatch } from "../src/browser/bridge.ts";
import { mcpServerDescriptor, startWebViewMcpServer, type WebViewMcpServer } from "../src/browser/mcp-server.ts";

const paths: string[] = [];
const servers: WebViewMcpServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

/** A "device" that answers whatever it is asked with `reply`, synchronously, from inside `dispatch.send`. */
function harness(reply: WebViewActionResult) {
  const path = `/tmp/ompd-webview-mcp-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  const agent: Agent = {
    id: "agt_00000000000000ff",
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
  let bridge: WebViewBridge;
  const dispatch: WebViewDispatch = {
    send: (agentId, requestId, action) => {
      sent.push({ agentId, requestId, action });
      bridge.resolveResult(agentId, requestId, reply);
      return true;
    },
  };
  bridge = new WebViewBridge({ policy: new DefaultPolicy({ mode: "standard" }), store, dispatch });
  const server = startWebViewMcpServer(bridge);
  servers.push(server);
  return { server, bridge, sent, agentId: agent.id };
}

async function rpc(url: string, method: string, params?: unknown, id: string | number = 1): Promise<{
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<{ name: string }> };
}> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as never;
}

describe("WebView MCP server: the tool-call boundary", () => {
  test("tools/list advertises exactly the five webview_* tools, matching the relay's vocabulary", async () => {
    const { server, agentId } = harness({ kind: "ack", url: "x", title: "x" });
    const body = await rpc(server.urlFor(agentId), "tools/list");
    const names = (body.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["webview_click", "webview_navigate", "webview_observe", "webview_screenshot", "webview_type"]);
  });

  test("tools/call for webview_observe (read-only) reaches the device and returns its observation as tool content", async () => {
    const observation = {
      kind: "observe" as const,
      observation: { url: "https://example.com", title: "Example", settled: true, tree: { tag: "body", ref: "n0" } },
    };
    const { server, sent, agentId } = harness(observation);
    const body = await rpc(server.urlFor(agentId), "tools/call", { name: "webview_observe", arguments: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toEqual({ kind: "observe" });
    expect(body.result?.isError).toBe(false);
    expect(JSON.parse(body.result?.content[0]?.text ?? "null")).toEqual(observation);
  });

  test("tools/call for webview_navigate is not auto-allowed: it fails closed, not silently no-op", async () => {
    const { server, sent, agentId } = harness({ kind: "ack", url: "x", title: "x" });
    const body = await rpc(server.urlFor(agentId), "tools/call", {
      name: "webview_navigate",
      arguments: { url: "https://example.com" },
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toContain("requires operator approval");
    // Never reached the device -- the whole point of the gate.
    expect(sent).toEqual([]);
  });

  test("a request against the wrong agent's token is refused before any JSON-RPC is parsed", async () => {
    const { server, agentId } = harness({ kind: "ack", url: "x", title: "x" });
    const realUrl = server.urlFor(agentId);
    const forged = realUrl.replace(/\/[0-9a-f]{64}$/, `/${"0".repeat(64)}`);
    const res = await fetch(forged, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });

  test("a request for an agent nobody minted a token for is refused, not treated as agent zero", async () => {
    const { server } = harness({ kind: "ack", url: "x", title: "x" });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/agt_deadbeefdeadbeef/${"a".repeat(64)}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });

  test("mcpServerDescriptor produces the http-type entry session/new.mcpServers expects", () => {
    const { server, agentId } = harness({ kind: "ack", url: "x", title: "x" });
    const descriptor = mcpServerDescriptor(server, agentId);
    expect(descriptor.type).toBe("http");
    expect(descriptor.name).toBe("ompd-webview");
    expect(typeof descriptor.url).toBe("string");
    expect(descriptor.url as string).toContain(`/mcp/${agentId}/`);
  });
});
