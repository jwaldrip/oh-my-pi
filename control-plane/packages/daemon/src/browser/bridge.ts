/**
 * Gate, then dispatch, one WebView action.
 *
 * Mutating actions are evaluated by policy here. An outright allow keeps the
 * direct fast path. A prompt is delegated to the supervisor-backed approval
 * gate, which gives WebView actions the same stored request, operator decision,
 * timeout, scope recording, and audit trail as an ordinary tool call.
 *
 * Observe and screenshot remain direct because policy classifies them as
 * read-only. They still reach policy, but an allow does not create a pointless
 * approval row or interrupt the operator.
 */

import {
  undriveableUrlReason,
  type Actor,
  type AgentId,
  type Policy,
  type Store,
  type WebViewAction,
  type WebViewActionResult,
} from "@ompd/core";

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

export interface WebViewApprovalGate {
  /** Resolves once a human decided, or the daemon's approval timeout fired. */
  request(input: {
    agentId: AgentId;
    tool: string;
    title: string;
    action: WebViewAction;
  }): Promise<{ allowed: boolean; reason: string }>;
}

export interface WebViewBridgeOptions {
  policy: Policy;
  store: Store;
  dispatch: WebViewDispatch;
  approvals?: WebViewApprovalGate;
  /** How long a dispatched action waits for a device to answer. */
  timeoutMs?: number;
}

interface Pending {
  agentId: AgentId;
  resolve: (result: WebViewActionResult) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function approvalTitle(action: WebViewAction): string {
  switch (action.kind) {
    case "navigate":
      return `Navigate to ${action.url}`;
    case "click":
      return `Click ${action.ref}`;
    case "type":
      return `Type ${JSON.stringify(action.text)} into ${action.ref}`;
    case "observe":
      return "Observe WebView";
    case "screenshot":
      return "Capture WebView screenshot";
  }
}

export class WebViewBridge {
  #policy: Policy;
  #store: Store;
  #dispatch: WebViewDispatch;
  #approvals: WebViewApprovalGate | undefined;
  #timeoutMs: number;
  #pending = new Map<string, Pending>();

  constructor(opts: WebViewBridgeOptions) {
    this.#policy = opts.policy;
    this.#store = opts.store;
    this.#dispatch = opts.dispatch;
    this.#approvals = opts.approvals;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Gate one action for one agent, then perform it.
   *
   * Dispatch follows an automatic allow or an explicit approval. A denial,
   * missing approval gate, or unsafe navigation never reaches the device.
   */
  async performAction(agentId: AgentId, action: WebViewAction): Promise<WebViewActionResult> {
    const agent = this.#store.getAgent(agentId);
    if (!agent) return { kind: "error", message: `no such agent: ${agentId}` };

    if (action.kind === "navigate") {
      const reason = undriveableUrlReason(action.url);
      if (reason !== null) {
        return { kind: "error", message: `cannot navigate to ${action.url}: ${reason}` };
      }
    }

    const tool = `webview_${action.kind}`;

    const decision = this.#policy.evaluate({
      agent,
      tool,
      input: action,
      actor: DAEMON_ACTOR,
    });

    if (decision.action === "deny") {
      return { kind: "error", message: `denied: ${decision.reason}` };
    }
    if (decision.action === "prompt") {
      const approvals = this.#approvals;
      if (approvals === undefined) return { kind: "error", message: PROMPT_NOT_WIRED };
      const approval = await approvals.request({
        agentId,
        tool,
        title: approvalTitle(action),
        action,
      });
      if (!approval.allowed) return { kind: "error", message: approval.reason };
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
