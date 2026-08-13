/**
 * Gate, then dispatch, one WebView action.
 *
 * This is the thing `docs/browser.md`'s "every mutating action reaches the
 * policy engine" claim is actually about. It deliberately does not go through
 * `Supervisor#gate`: that machinery opens a real `ApprovalRequest` row and
 * waits out `approvalTimeoutMs` for a human decision, which is correct for a
 * tool call a client screen can render an approval for. No client screen
 * renders a webview-action approval yet, so reusing it would mean every
 * `navigate`/`click`/`type` sits in the operator's approval queue for the
 * full timeout before failing anyway -- a worse answer than failing fast.
 *
 * So `performAction` evaluates the policy directly and stops there for
 * anything that is not an outright `allow`. `deny` and `prompt` are told
 * apart in the returned message (see `PROMPT_NOT_WIRED`) so a caller -- and
 * a future patch that wires an approval screen -- can tell "the policy
 * refused this" from "the policy wants a human ompd cannot yet ask."
 */

import type { Actor, AgentId, Policy, Store, WebViewAction, WebViewActionResult } from "@ompd/core";

/**
 * The same shape `Supervisor#gate` evaluates its own automatic decisions
 * under: policy is a verdict about the action, not about which client is
 * attached, so the actor here carries full scopes and never varies.
 */
const DAEMON_ACTOR: Actor = { deviceId: "daemon", scopes: ["read", "prompt", "approve"] };

/**
 * The message a caller sees when the policy engine wants a human and ompd has
 * nowhere to ask one yet. Distinct from a policy `deny` on purpose: the first
 * is "no", the second is "this needs a decision this build cannot render."
 */
export const PROMPT_NOT_WIRED = "requires operator approval, not yet wired for WebView actions";

export const NO_RESPONSE = "no response from the device within the timeout";
export const NO_TARGET = "no registered WebView is available for this agent";

/** How the bridge actually reaches a device. Implemented by whatever owns live connections (the gateway). */
export interface WebViewDispatch {
  /**
   * Push the action to the device currently registered for `agentId`.
   * `false` means there is no usable target, so the caller fails now rather
   * than waiting out a timeout for a frame that could never arrive.
   */
  send(agentId: AgentId, requestId: string, action: WebViewAction): boolean;
}

export interface WebViewBridgeOptions {
  policy: Policy;
  store: Store;
  dispatch: WebViewDispatch;
  /** How long a dispatched action waits for a device to answer. */
  timeoutMs?: number;
}

interface Pending {
  agentId: AgentId;
  resolve: (result: WebViewActionResult) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class WebViewBridge {
  #policy: Policy;
  #store: Store;
  #dispatch: WebViewDispatch;
  #timeoutMs: number;
  #pending = new Map<string, Pending>();

  constructor(opts: WebViewBridgeOptions) {
    this.#policy = opts.policy;
    this.#store = opts.store;
    this.#dispatch = opts.dispatch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Gate one action for one agent, then perform it.
   *
   * `dispatch.send` is called if and only if the policy said `allow`. That is
   * the entire claim "an action reaches the policy engine" reduces to, and it
   * is what `bridge.test.ts` asserts directly against a spy in place of
   * `dispatch`.
   */
  async performAction(agentId: AgentId, action: WebViewAction): Promise<WebViewActionResult> {
    const agent = this.#store.getAgent(agentId);
    if (!agent) return { kind: "error", message: `no such agent: ${agentId}` };

    const decision = this.#policy.evaluate({
      agent,
      tool: `webview_${action.kind}`,
      input: action,
      actor: DAEMON_ACTOR,
    });

    if (decision.action === "deny") {
      return { kind: "error", message: `denied: ${decision.reason}` };
    }
    if (decision.action === "prompt") {
      return { kind: "error", message: PROMPT_NOT_WIRED };
    }

    const requestId = `wv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return await new Promise<WebViewActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) resolve({ kind: "error", message: NO_RESPONSE });
      }, this.#timeoutMs);
      this.#pending.set(requestId, {
        agentId,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      if (!this.#dispatch.send(agentId, requestId, action)) {
        const pending = this.#pending.get(requestId);
        if (pending) {
          this.#pending.delete(requestId);
          pending.resolve({ kind: "error", message: NO_TARGET });
        }
      }
      // Sent after the pending row exists, so a same-tick device answer can
      // settle it; the dispatch above is the only outbound action.
    });
  }

  /**
   * A device's answer to a dispatched action, arriving as `webview_result`.
   * Returns false for a different agent, an unknown request id, or an
   * already-settled request id rather than throwing. The agent check matters:
   * request ids are opaque capabilities, but an authenticated client still
   * must not settle another session's action by replaying one it observed.
   */
  resolveResult(
    agentId: AgentId,
    requestId: string,
    result: WebViewActionResult,
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.agentId !== agentId) return false;
    this.#pending.delete(requestId);
    pending.resolve(result);
    return true;
  }

  /** A device that disconnects mid-action fails the caller now, not after the full timeout. */
  cancelAgent(agentId: AgentId, reason: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.agentId !== agentId) continue;
      this.#pending.delete(requestId);
      pending.resolve({ kind: "error", message: reason });
    }
  }
}
