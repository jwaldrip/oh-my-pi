/**
 * A minimal MCP server, over Streamable HTTP, exposing `webview_*` tools.
 *
 * This is how the agent becomes able to call any of this at all: OMP's ACP
 * mode deliberately disables its own on-disk `.mcp.json` discovery
 * (`AcpAgent#configureMcpServers` owns MCP mounting exclusively -- see
 * `packages/coding-agent/src/main.ts`), so `session/new.mcpServers` is the
 * only door. `@ompd/acp`'s `newSession` already threads an `mcpServers` array
 * through; `supervisor.ts` builds one entry per agent from
 * {@link mcpServerDescriptor} and this server is what answers it.
 *
 * Bound to loopback only, and gated by a per-agent token neither guessable
 * nor reused across agents -- defence in depth on top of the loopback bind,
 * since the only intended caller is this machine's own `omp acp` child
 * process, not a network peer.
 *
 * Deliberately not the full MCP spec: one JSON-RPC object per POST (no
 * batching, no SSE stream), which is everything `initialize` / `tools/list`
 * / `tools/call` need for a single agent driving one WebView.
 */

import type { AgentId, WebViewAction } from "@ompd/core";
import type { WebViewBridge } from "./bridge.ts";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The five tools, in the vocabulary `docs/browser.md` fixes: navigate,
 * observe, click, type, screenshot. Named `webview_*` so nothing here is ever
 * mistaken for OMP's own `browser`/`computer` tools, which drive a different
 * surface entirely.
 */
const TOOLS: ToolSchema[] = [
  {
    name: "webview_navigate",
    description: "Navigate this app's embedded WebView to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "webview_observe",
    description:
      "Read the WebView's current page as a structural tree (tag, role, text, a small attribute set), not a screenshot. Use this to find what to click or type into.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "webview_click",
    description: "Click the element named by `ref` from a prior webview_observe.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "webview_type",
    description: "Type text into the element named by `ref` from a prior webview_observe.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        replace: { type: "boolean", description: "Clear the field first. Defaults to false (append)." },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "webview_screenshot",
    description: "Capture the WebView's current appearance as a PNG. For layout/visual judgment, not for finding a click target -- use webview_observe for that.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** `null` for a call this server does not recognise as a `WebViewAction`. */
function parseAction(name: string, rawArgs: unknown): WebViewAction | null {
  const args = rawArgs !== null && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  switch (name) {
    case "webview_navigate":
      return typeof args.url === "string" ? { kind: "navigate", url: args.url } : null;
    case "webview_observe":
      return { kind: "observe" };
    case "webview_click":
      return typeof args.ref === "string" ? { kind: "click", ref: args.ref } : null;
    case "webview_type":
      return typeof args.ref === "string" && typeof args.text === "string"
        ? { kind: "type", ref: args.ref, text: args.text, replace: args.replace === true }
        : null;
    case "webview_screenshot":
      return { kind: "screenshot" };
    default:
      return null;
  }
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export interface WebViewMcpServer {
  /** The `session/new.mcpServers` URL for `agentId`. Mints a fresh token on first call for that agent. */
  urlFor(agentId: AgentId): string;
  /** The bound loopback port, for a caller that already has a token and only needs the port (tests). */
  readonly port: number;
  close(): void;
}

/** `wv_mcp_<32 hex>`: a token, not an identifier -- distinct prefix from `WebViewBridge`'s own `wv_` request ids so the two are never confused in a log. */
function mintToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

const ROUTE = /^\/mcp\/(agt_[0-9a-f]+)\/([0-9a-f]{64})$/;

export function startWebViewMcpServer(bridge: WebViewBridge): WebViewMcpServer {
  const tokens = new Map<AgentId, string>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const match = ROUTE.exec(new URL(req.url).pathname);
      if (!match) return new Response("not found", { status: 404 });
      const [, agentId, token] = match as unknown as [string, AgentId, string];
      if (tokens.get(agentId) !== token) return new Response("forbidden", { status: 403 });

      let msg: JsonRpcRequest;
      try {
        msg = (await req.json()) as JsonRpcRequest;
      } catch {
        return rpcError(null, -32700, "parse error");
      }
      if (typeof msg.method !== "string") return rpcError(msg.id ?? null, -32600, "invalid request");

      switch (msg.method) {
        case "initialize":
          return rpcResult(msg.id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "ompd-webview", version: "0.1.0" },
          });
        case "notifications/initialized":
          // A notification carries no id and expects no JSON-RPC response body.
          return new Response(null, { status: 202 });
        case "tools/list":
          return rpcResult(msg.id, { tools: TOOLS });
        case "tools/call": {
          const params =
            msg.params !== null && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
          const name = typeof params.name === "string" ? params.name : "";
          const action = parseAction(name, params.arguments);
          if (!action) return rpcError(msg.id, -32602, `unknown or malformed tool call: ${name}`);
          const result = await bridge.performAction(agentId, action);
          const text = result.kind === "error" ? result.message : JSON.stringify(result);
          return rpcResult(msg.id, { content: [{ type: "text", text }], isError: result.kind === "error" });
        }
        default:
          return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
      }
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("webview mcp server bound no port");

  return {
    port,
    urlFor(agentId) {
      let token = tokens.get(agentId);
      if (!token) {
        token = mintToken();
        tokens.set(agentId, token);
      }
      return `http://127.0.0.1:${port}/mcp/${agentId}/${token}`;
    },
    close() {
      server.stop(true);
    },
  };
}

/** The `session/new.mcpServers` entry ACP's `McpServer` (http variant) expects. */
export function mcpServerDescriptor(server: WebViewMcpServer, agentId: AgentId): Record<string, unknown> {
  return {
    name: "ompd-webview",
    type: "http",
    url: server.urlFor(agentId),
    // The bridge owns the target-aware approval after it has parsed and
    // validated the action. OMP's generic MCP wrapper cannot see that target.
    _meta: { "omp.toolApproval": "allow" },
  };
}
