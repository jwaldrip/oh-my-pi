/**
 * Everything the console knows, and the one function that changes it.
 *
 * The session reducer turns one agent's update stream into a transcript. This
 * turns the whole client event stream into a screen: which agents exist, which
 * one is open, whether the link is up, and what this device is still allowed to
 * do. It is pure for the same reason the session reducer is: a canned stream of
 * frames must produce exactly the state a live daemon would, or the tests prove
 * nothing about the real thing.
 *
 * Sessions are kept for every agent whether or not it is on screen, so
 * switching strips is instant and a strip nobody is watching still reports its
 * load and its spend.
 */

import type { Agent, AgentId, ApprovalChoice } from "@ompd/core/contracts";
import { SCOPE_APPROVE } from "@ompd/core/contracts";
import type {
  AgentsEvent,
  ApprovalEvent,
  ClientErrorEvent,
  SayEvent,
  StatusEvent,
  UnauthorizedEvent,
  UpdateEvent,
  ConnectionState,
} from "@ompd/core/ompd-client";
import type { BrowserSession } from "../session/browser.ts";
import type { SessionState } from "../session/model.ts";
import { EMPTY_SESSION, appendApproval, appendPrompt, endTurn, reduce, resolveApproval } from "../session/model.ts";

/**
 * What a strip shows. Kept here rather than beside a component, because the
 * component that rendered it is gone and this is a pure derived shape a
 * future readout can reuse without pulling in a view.
 */
export interface StripStats {
  /** Fraction of the context window consumed, in `[0, 1]`. Null when unknown. */
  contextFraction: number | null;
  costAmount: number | null;
  costCurrency: string;
  tools: number;
  running: number;
  clearances: number;
}

/**
 * Error codes that mean the daemon overruled this device, not that the link
 * broke. The gateway wears `unauthorized` for both a dead token and a missing
 * scope; the client settles the first case on its own and emits
 * `unauthorized`, so seeing the code here means the second.
 */
const SCOPE_CODES: Record<string, true> = { forbidden: true, scope: true, unauthorized: true };

export interface ConsoleState {
  readonly agents: readonly Agent[];
  readonly sessions: ReadonlyMap<AgentId, SessionState>;
  /** Highest `seq` seen per agent, for the readout and for `say` de-duplication. */
  readonly watermarks: ReadonlyMap<AgentId, number>;
  /** Latest spoken summary per agent. Text only; this build has no voice. */
  readonly spoken: ReadonlyMap<AgentId, { seq: number; text: string }>;
  readonly connection: ConnectionState;
  readonly attempt: number;
  readonly delayMs: number | undefined;
  readonly selected: AgentId | null;
  readonly canApprove: boolean;
  /** Why approval is refused, once the daemon has actually refused it. */
  readonly refusal: string | undefined;
  /** Transient message for the operator. Cleared by `dismiss`. */
  readonly notice: string | null;
  /** Set once the daemon has confirmed the token is dead. Terminal. */
  readonly unauthorized: string | null;
}

export function emptyConsole(scopes: readonly string[]): ConsoleState {
  return {
    agents: [],
    sessions: new Map(),
    watermarks: new Map(),
    spoken: new Map(),
    connection: "connecting",
    attempt: 0,
    delayMs: undefined,
    selected: null,
    // A pairing that did not declare its scopes stays optimistic; the daemon's
    // first refusal is what downgrades it.
    canApprove: scopes.length === 0 || scopes.includes(SCOPE_APPROVE),
    refusal: undefined,
    notice: null,
    unauthorized: null,
  };
}

export type ConsoleEvent =
  | { t: "status"; event: StatusEvent }
  | { t: "agents"; event: AgentsEvent }
  | { t: "update"; event: UpdateEvent }
  | { t: "approval"; event: ApprovalEvent }
  | { t: "error"; event: ClientErrorEvent }
  | { t: "say"; event: SayEvent }
  | { t: "unauthorized"; event: UnauthorizedEvent }
  /** Local: the operator opened a strip, or went back to the bay. */
  | { t: "select"; agentId: AgentId | null }
  /** Local: echo of a prompt this device just sent. */
  | { t: "prompt"; agentId: AgentId; text: string }
  /** Local: a clearance this device just settled. */
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice }
  | { t: "dismiss" };

/**
 * Folds one event into the console. Returns the same state by reference when
 * nothing changed, so React skips the render.
 */
export function apply(state: ConsoleState, event: ConsoleEvent): ConsoleState {
  switch (event.t) {
    case "status":
      return {
        ...state,
        connection: event.event.state,
        attempt: event.event.attempt,
        delayMs: event.event.delayMs,
      };

    case "agents":
      return applyAgents(state, event.event.agents);

    case "update": {
      const { agentId, seq, update } = event.event;
      const watermarks = new Map(state.watermarks);
      watermarks.set(agentId, seq);
      return { ...withSession(state, agentId, (session) => reduce(session, update)), watermarks };
    }

    case "approval": {
      const { agentId, requestId, tool, title, input } = event.event;
      const next = withSession(state, agentId, (session) =>
        appendApproval(session, { requestId, tool, title, input }),
      );
      if (agentId === state.selected) return next;
      const name = state.agents.find((agent) => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a clearance.` };
    }

    case "error": {
      const { code, message } = event.event;
      if (code !== undefined && SCOPE_CODES[code]) {
        return {
          ...state,
          canApprove: false,
          refusal: `${message}. Sign this from a device holding the approve scope.`,
          notice: message,
        };
      }
      return { ...state, notice: message };
    }

    case "say":
      return applySay(state, event.event);

    case "unauthorized":
      return { ...state, unauthorized: event.event.reason, connection: "offline" };

    case "select": {
      if (state.selected === event.agentId) return state;
      if (event.agentId === null) return { ...state, selected: null };
      return { ...state, selected: event.agentId };
    }

    case "prompt":
      return withSession(state, event.agentId, (session) => appendPrompt(session, event.text));

    case "decide":
      return withSession(state, event.agentId, (session) =>
        resolveApproval(session, event.requestId, event.choice),
      );

    case "dismiss":
      return state.notice === null ? state : { ...state, notice: null };

    default:
      return state;
  }
}

/**
 * The roster is the authority on which agents exist. An agent that has left it
 * is never coming back on that id, so its transcript goes with it: keeping one
 * would grow without bound across a long-running session and show a log for
 * something that no longer exists.
 */
function applyAgents(state: ConsoleState, agents: readonly Agent[]): ConsoleState {
  const before = new Map(state.agents.map((agent) => [agent.id, agent]));
  const live = new Set(agents.map((agent) => agent.id));

  const sessions = new Map(state.sessions);
  for (const agent of agents) {
    // A turn that has stopped leaves nothing streaming, whatever the last
    // chunk claimed. Without this an interrupted turn keeps its caret forever.
    if (agent.state !== "busy" && before.get(agent.id)?.state === "busy") {
      const session = sessions.get(agent.id);
      if (session !== undefined) sessions.set(agent.id, endTurn(session));
    }
  }

  const watermarks = new Map(state.watermarks);
  const spoken = new Map(state.spoken);
  for (const agentId of [...sessions.keys()]) {
    if (live.has(agentId)) continue;
    sessions.delete(agentId);
    watermarks.delete(agentId);
    spoken.delete(agentId);
  }

  const selected = state.selected !== null && live.has(state.selected) ? state.selected : null;
  const lost = state.selected !== null && selected === null;

  return {
    ...state,
    agents,
    sessions,
    watermarks,
    spoken,
    selected,
    notice: lost ? "That agent is gone." : state.notice,
  };
}

/**
 * A rendering hint and nothing more. `seq` is the update the prose derives
 * from, so a replay after a reconnect cannot make the app repeat a summary it
 * has already shown, and a stale frame cannot overwrite a newer one.
 */
function applySay(state: ConsoleState, event: SayEvent): ConsoleState {
  const previous = state.spoken.get(event.agentId);
  if (previous !== undefined && event.seq <= previous.seq) return state;
  const spoken = new Map(state.spoken);
  spoken.set(event.agentId, { seq: event.seq, text: event.text });
  return { ...state, spoken };
}

function withSession(
  state: ConsoleState,
  agentId: AgentId,
  change: (session: SessionState) => SessionState,
): ConsoleState {
  const before = state.sessions.get(agentId) ?? EMPTY_SESSION;
  const after = change(before);
  if (after === before) return state;
  const sessions = new Map(state.sessions);
  sessions.set(agentId, after);
  return { ...state, sessions };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function sessionFor(state: ConsoleState, agentId: AgentId): SessionState {
  return state.sessions.get(agentId) ?? EMPTY_SESSION;
}

/** What a strip shows. Derived rather than stored, so it cannot go stale. */
export function stripStats(session: SessionState): StripStats {
  const usage = session.usage;
  return {
    contextFraction: usage === null || usage.size === 0 ? null : usage.used / usage.size,
    costAmount: usage === null ? null : usage.costAmount,
    costCurrency: usage?.costCurrency ?? "USD",
    tools: session.activity.tools,
    running: session.activity.running,
    clearances: session.pendingApprovals.length,
  };
}

export function allStats(state: ConsoleState): Map<AgentId, StripStats> {
  const stats = new Map<AgentId, StripStats>();
  for (const [agentId, session] of state.sessions) stats.set(agentId, stripStats(session));
  return stats;
}

/**
 * Clearances across the whole fleet, not just the open strip. The readout is
 * the only place an operator sees that a strip they are not looking at has
 * stopped and is waiting on them.
 */
export function fleetClearances(state: ConsoleState): number {
  let total = 0;
  for (const session of state.sessions.values()) total += session.pendingApprovals.length;
  return total;
}

/**
 * Adapts this device's live ACP roster into browser rows.
 *
 * Temporary: `session/list` caps at 50 and only ever describes agents this
 * client is attached to, so every row it can produce is `live-ompd`. The
 * moment the daemon index ships a route over the full on-disk session store,
 * this is the seam that gets replaced: swap the call site in `Console.tsx`
 * for a fetch against that route, which will also be the first source able to
 * report `live-tui`, `dormant`, `archived`, message counts, and sizes for
 * sessions this device has never attached to.
 */
export function browserSessionsOf(state: ConsoleState): BrowserSession[] {
  return state.agents.map((agent) => {
    const session = state.sessions.get(agent.id) ?? EMPTY_SESSION;
    return {
      id: agent.id,
      title: agent.name,
      cwd: agent.cwd,
      status: "live-ompd",
      createdAt: agent.createdAt,
      lastActiveAt: agent.lastActiveAt,
      messageCount: session.entries.length,
      // Not knowable from a live ACP stream; the disk-backed index owns this.
      sizeBytes: 0,
    };
  });
}
