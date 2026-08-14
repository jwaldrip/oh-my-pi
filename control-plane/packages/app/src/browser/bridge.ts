/**
 * The message bridge between the native side and the page running inside the
 * WebView -- pure logic, no `react-native-webview` import, so it is testable
 * under plain `bun test` the way `platform/connection.ts`'s `coerce` is.
 *
 * See "Page content can only ever become data" in `docs/browser.md`. The
 * property this file exists to hold: {@link parseBridgeMessage} has no
 * `{ kind: "action" }` case in its return type. A page's own script calling
 * `window.ReactNativeWebView.postMessage` on its own initiative -- unsolicited,
 * replayed, or shaped to look like a bridge reply -- can only ever come back
 * as `{ kind: "dropped" }`. There is no code path from "the page said
 * something" to "the app did something."
 *
 * The nonce is a correlation token, not a secret: only one request is ever
 * outstanding, its value exists nowhere until the native side injects the
 * exact script naming it, and a page cannot pre-forge a reply to a request
 * that has not been issued yet. Its job is to reject a stale or unsolicited
 * reply, not to resist a targeted attacker who already controls the page --
 * that page cannot cause an action either way, which is the actual guarantee.
 */

import type { WebViewAction, WebViewActionResult, WebViewNode, WebViewObservation } from "@ompd/core/contracts";

export type BridgeEvent = { kind: "resolved"; result: WebViewActionResult } | { kind: "dropped"; reason: string };

/**
 * Parse one `onMessage` payload against the one nonce currently outstanding.
 *
 * `expectedNonce === null` means nothing is outstanding: every message is
 * dropped, which is the correct behaviour for a page that talks without
 * being asked anything.
 */
export function parseBridgeMessage(expectedNonce: string | null, raw: string): BridgeEvent {
  if (expectedNonce === null) return { kind: "dropped", reason: "no request outstanding" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "dropped", reason: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "dropped", reason: "not an object" };
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 1) return { kind: "dropped", reason: "unknown envelope version" };
  if (envelope.nonce !== expectedNonce) return { kind: "dropped", reason: "nonce mismatch" };

  const result = coerceResult(envelope.result);
  return result ? { kind: "resolved", result } : { kind: "dropped", reason: "malformed result" };
}

/** A nonce for one outstanding request. `Math.random` twice plus the clock: adequate for correlation, not a cryptographic secret -- see the module doc for why that distinction is the whole security argument here. */
export function mintNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function coerceResult(value: unknown): WebViewActionResult | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "observe": {
      const observation = coerceObservation(v.observation);
      return observation && { kind: "observe", observation };
    }
    case "screenshot":
      return typeof v.pngBase64 === "string" ? { kind: "screenshot", pngBase64: v.pngBase64 } : null;
    case "ack":
      return typeof v.url === "string" && typeof v.title === "string" ? { kind: "ack", url: v.url, title: v.title } : null;
    case "error":
      return typeof v.message === "string" ? { kind: "error", message: v.message } : null;
    default:
      return null;
  }
}

function coerceObservation(value: unknown): WebViewObservation | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const tree = coerceNode(v.tree, 0);
  if (typeof v.url !== "string" || typeof v.title !== "string" || typeof v.settled !== "boolean" || !tree) return null;
  return { url: v.url, title: v.title, settled: v.settled, tree };
}

/** A page cannot cause unbounded recursion here: a subtree past this depth is dropped from its parent's `children` rather than walked further, so a pathological or hostile message truncates instead of ever reaching the native stack limit. */
const MAX_COERCE_DEPTH = 40;

function coerceNode(value: unknown, depth: number): WebViewNode | null {
  if (depth > MAX_COERCE_DEPTH) return null;
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.tag !== "string" || typeof v.ref !== "string") return null;

  const node: WebViewNode = { tag: v.tag, ref: v.ref };
  if (typeof v.role === "string") node.role = v.role;
  if (typeof v.text === "string") node.text = v.text;
  if (v.attributes !== null && typeof v.attributes === "object") {
    const attrs: Record<string, string> = {};
    for (const [key, val] of Object.entries(v.attributes as Record<string, unknown>)) {
      if (typeof val === "string") attrs[key] = val;
    }
    node.attributes = attrs;
  }
  if (Array.isArray(v.children)) {
    const children: WebViewNode[] = [];
    for (const child of v.children) {
      const coerced = coerceNode(child, depth + 1);
      if (coerced) children.push(coerced);
    }
    node.children = children;
  }
  return node;
}

/** Attributes read out of the page's DOM. Small on purpose: enough to name a form field or a link, never enough to leak a page's full markup into the model's context. */
const ATTRIBUTE_ALLOWLIST = ["id", "role", "aria-label", "aria-hidden", "placeholder", "value", "href", "type", "name", "title", "alt"];
const MAX_NODES = 400;
const MAX_TREE_DEPTH = 24;
const MAX_TEXT_CHARS = 200;

/**
 * The script injected to perform one `observe`/`click`/`type` and post its
 * result back. `navigate` and `screenshot` are handled natively -- see
 * `WebViewDriver.tsx` -- because navigation would unload the page before an
 * injected script's own `postMessage` could reliably fire, and a screenshot
 * is a capture of the native view, not something page JS can produce.
 *
 * `nonce` and `action` are embedded via `JSON.stringify`, read back inside
 * the injected script via `JSON.parse` semantics (object/array/string
 * literals), never string-concatenated into executable code a page's own
 * content could reach into.
 */
export function buildInjectedScript(nonce: string, action: WebViewAction): string {
  const post = `function(result){window.ReactNativeWebView.postMessage(JSON.stringify({v:1,nonce:${JSON.stringify(nonce)},result:result}));}`;
  return `(function(){
try {
  var __post = ${post};
  var __ompd = window.__ompdBridge || (window.__ompdBridge = { refs: {}, next: 0 });
  var __action = ${JSON.stringify(action)};
  function __walk(el, depth) {
    if (!el || depth > ${MAX_TREE_DEPTH} || __ompd.next >= ${MAX_NODES}) return null;
    var ref = "n" + (__ompd.next++);
    __ompd.refs[ref] = el;
    var node = { tag: (el.tagName || "").toLowerCase(), ref: ref };
    var role = el.getAttribute && el.getAttribute("role");
    if (role) node.role = role;
    var text = "";
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) { if (kids[i].nodeType === 3) text += kids[i].nodeValue; }
    text = text.trim();
    if (text) node.text = text.slice(0, ${MAX_TEXT_CHARS});
    var attrs = {};
    var allow = ${JSON.stringify(ATTRIBUTE_ALLOWLIST)};
    for (var j = 0; j < allow.length; j++) {
      var v = el.getAttribute && el.getAttribute(allow[j]);
      if (v != null) attrs[allow[j]] = String(v).slice(0, ${MAX_TEXT_CHARS});
    }
    if (Object.keys(attrs).length) node.attributes = attrs;
    var childEls = el.children || [];
    var out = [];
    for (var k = 0; k < childEls.length; k++) {
      var child = __walk(childEls[k], depth + 1);
      if (child) out.push(child);
    }
    if (out.length) node.children = out;
    return node;
  }
  if (__action.kind === "observe") {
    __ompd.refs = {};
    __ompd.next = 0;
    var tree = __walk(document.body, 0) || { tag: "body", ref: "n0" };
    __post({ kind: "observe", observation: { url: location.href, title: document.title, settled: document.readyState === "complete", tree: tree } });
  } else if (__action.kind === "click") {
    var target = __ompd.refs[__action.ref];
    if (!target) { __post({ kind: "error", message: "stale ref: " + __action.ref }); }
    else { target.click(); __post({ kind: "ack", url: location.href, title: document.title }); }
  } else if (__action.kind === "type") {
    var field = __ompd.refs[__action.ref];
    if (!field) { __post({ kind: "error", message: "stale ref: " + __action.ref }); }
    else {
      if (__action.replace) field.value = "";
      field.focus && field.focus();
      field.value = (field.value || "") + __action.text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      __post({ kind: "ack", url: location.href, title: document.title });
    }
  } else {
    __post({ kind: "error", message: "webview.ts sent a native-only action into the page: " + __action.kind });
  }
} catch (e) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ v: 1, nonce: ${JSON.stringify(nonce)}, result: { kind: "error", message: String((e && e.message) || e) } })); } catch (e2) {}
}
true;
})();`;
}
