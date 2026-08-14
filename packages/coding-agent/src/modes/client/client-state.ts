/**
 * Pure state machine for the TUI's daemon-client mode.
 *
 * Deliberately has no network, no terminal, and no timers: every transition is
 * `(state, action) -> state`, so the keystone properties this mode exists to
 * prove — switching the viewed agent never spawns a process, a reattach with
 * `sinceSeq: 0` replays a full transcript rather than losing one — are
 * testable without a daemon or a live socket. `client-mode.ts` is the only
 * caller; it turns `OmpdClient` events into actions and this module's output
 * into rendered rows.
 *
 * Per control-plane/docs/portability.md: an `AgentId` identifies an agent, not
 * a machine, and `cwd` here is display data grouped under it, never an
 * identity or address. Nothing in this module keys off which daemon or host
 * an agent's process happens to run on.
 */

import type { Agent, AgentId } from "@ompd/core/contracts";

export interface TranscriptLine {
	seq: number;
	text: string;
}

export interface PendingApproval {
	requestId: string;
	title: string;
	tool: string;
}

export interface AgentView {
	agent: Agent;
	/** True once this client has sent `attach` for this agent at least once. */
	attached: boolean;
	lines: TranscriptLine[];
	pendingApproval: PendingApproval | null;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface ClientState {
	status: ConnectionStatus;
	statusReason: string | undefined;
	/** Keyed by agent id; the only place agent data lives. */
	agents: ReadonlyMap<AgentId, AgentView>;
	/** Grouped-by-cwd, ordered-by-urgency display order. A view, not an identity. */
	order: readonly AgentId[];
	/** The agent whose transcript is currently rendered, or null with no agents. */
	viewing: AgentId | null;
	lastError: string | undefined;
}

export function createClientState(): ClientState {
	return {
		status: "offline",
		statusReason: undefined,
		agents: new Map(),
		order: [],
		viewing: null,
		lastError: undefined,
	};
}

export type ClientAction =
	| { type: "status"; status: ConnectionStatus; reason?: string }
	| { type: "agents"; agents: readonly Agent[] }
	| { type: "view"; agentId: AgentId }
	| { type: "viewNext"; direction: 1 | -1 }
	| { type: "attaching"; agentId: AgentId }
	| { type: "line"; agentId: AgentId; seq: number; text: string }
	| { type: "approval"; agentId: AgentId; requestId: string; title: string; tool: string }
	| { type: "approvalResolved"; agentId: AgentId; requestId: string }
	| { type: "error"; message: string };

/** Bounded so a long-lived attach cannot grow the buffer without limit. */
export const MAX_LINES_PER_AGENT = 4000;

/**
 * Live-agent urgency, lowest first: an agent waiting on the operator or mid-turn
 * belongs above one that is merely idle or still starting.
 */
const STATE_RANK: Record<Agent["state"], number> = {
	waiting: 0,
	busy: 1,
	idle: 2,
	starting: 3,
	provisioning: 4,
	stopped: 5,
	failed: 6,
};

function sortAgents(agents: readonly Agent[]): Agent[] {
	return [...agents].sort((a, b) => {
		const byCwd = a.cwd.localeCompare(b.cwd);
		if (byCwd !== 0) return byCwd;
		const byState = (STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99);
		if (byState !== 0) return byState;
		// Most recently active first within a state/directory group.
		return b.lastActiveAt.localeCompare(a.lastActiveAt);
	});
}

function withAgent(state: ClientState, agentId: AgentId, update: (view: AgentView) => AgentView): ClientState {
	const view = state.agents.get(agentId);
	if (!view) return state;
	const agents = new Map(state.agents);
	agents.set(agentId, update(view));
	return { ...state, agents };
}

export function reduceClientState(state: ClientState, action: ClientAction): ClientState {
	switch (action.type) {
		case "status":
			return { ...state, status: action.status, statusReason: action.reason };

		case "agents": {
			const sorted = sortAgents(action.agents);
			const agents = new Map<AgentId, AgentView>();
			const order: AgentId[] = [];
			for (const agent of sorted) {
				order.push(agent.id);
				const existing = state.agents.get(agent.id);
				agents.set(
					agent.id,
					existing ? { ...existing, agent } : { agent, attached: false, lines: [], pendingApproval: null },
				);
			}
			// An agent the daemon no longer reports (stopped and pruned, or genuinely
			// gone) drops from the live set. There is nothing left to reattach to.
			const viewing = state.viewing !== null && agents.has(state.viewing) ? state.viewing : (order[0] ?? null);
			return { ...state, agents, order, viewing };
		}

		case "view": {
			if (!state.agents.has(action.agentId)) return state;
			if (state.viewing === action.agentId) return state;
			return { ...state, viewing: action.agentId };
		}

		case "viewNext": {
			if (state.order.length === 0) return state;
			const currentIndex = state.viewing === null ? -1 : state.order.indexOf(state.viewing);
			const nextIndex = (currentIndex + action.direction + state.order.length) % state.order.length;
			const nextId = state.order[nextIndex];
			if (nextId === undefined || nextId === state.viewing) return state;
			return { ...state, viewing: nextId };
		}

		case "attaching":
			return withAgent(state, action.agentId, view => ({ ...view, attached: true }));

		case "line": {
			return withAgent(state, action.agentId, view => {
				const lines = [...view.lines, { seq: action.seq, text: action.text }];
				if (lines.length > MAX_LINES_PER_AGENT) lines.splice(0, lines.length - MAX_LINES_PER_AGENT);
				return { ...view, attached: true, lines };
			});
		}

		case "approval": {
			return withAgent(state, action.agentId, view => ({
				...view,
				pendingApproval: { requestId: action.requestId, title: action.title, tool: action.tool },
			}));
		}

		case "approvalResolved": {
			return withAgent(state, action.agentId, view =>
				view.pendingApproval?.requestId === action.requestId ? { ...view, pendingApproval: null } : view,
			);
		}

		case "error":
			return { ...state, lastError: action.message };

		default:
			return state;
	}
}
