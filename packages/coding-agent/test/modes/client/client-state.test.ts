/**
 * The client mode's state machine: pure `(state, action) -> state`.
 *
 * These are the properties the keystone requirement actually rests on:
 * switching the viewed agent is a `view`/`viewNext` reduction with no side
 * effect (no attach call lives inside the reducer, let alone a process
 * spawn), and an agent's transcript accumulates independently of which agent
 * is currently viewed, so switching back after a kill-and-reattach shows
 * exactly what arrived while it was in the background.
 */

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import {
	type ClientState,
	createClientState,
	MAX_LINES_PER_AGENT,
	reduceClientState,
} from "../../../src/modes/client/client-state";

function agent(overrides: Partial<Agent> & { id: string }): Agent {
	return {
		name: overrides.id,
		state: "idle",
		host: { kind: "local", id: "h1" },
		cwd: "/repo",
		createdAt: "2024-01-01T00:00:00.000Z",
		lastActiveAt: "2024-01-01T00:00:00.000Z",
		labels: {},
		...overrides,
	};
}

describe("reduceClientState: agents", () => {
	test("first agents frame selects the first agent in display order as viewing", () => {
		const state = reduceClientState(createClientState(), {
			type: "agents",
			agents: [agent({ id: "a2", cwd: "/repo/b" }), agent({ id: "a1", cwd: "/repo/a" })],
		});
		expect(state.order).toEqual(["a1", "a2"]);
		expect(state.viewing).toBe("a1");
	});

	test("groups by cwd, then ranks by urgency (waiting > busy > idle > starting > provisioning > stopped > failed)", () => {
		const state = reduceClientState(createClientState(), {
			type: "agents",
			agents: [
				agent({ id: "idle-b", cwd: "/repo/b", state: "idle" }),
				agent({ id: "waiting-a", cwd: "/repo/a", state: "waiting" }),
				agent({ id: "busy-a", cwd: "/repo/a", state: "busy" }),
				agent({ id: "waiting-b", cwd: "/repo/b", state: "waiting" }),
			],
		});
		expect(state.order).toEqual(["waiting-a", "busy-a", "waiting-b", "idle-b"]);
	});

	test("a later agents frame preserves the currently viewed agent when it still exists", () => {
		let state = reduceClientState(createClientState(), {
			type: "agents",
			agents: [agent({ id: "a1" }), agent({ id: "a2" })],
		});
		state = reduceClientState(state, { type: "view", agentId: "a2" });
		state = reduceClientState(state, {
			type: "agents",
			agents: [agent({ id: "a1" }), agent({ id: "a2" })],
		});
		expect(state.viewing).toBe("a2");
	});

	test("a later agents frame re-picks viewing when the viewed agent is gone", () => {
		let state = reduceClientState(createClientState(), {
			type: "agents",
			agents: [agent({ id: "a1" }), agent({ id: "a2" })],
		});
		state = reduceClientState(state, { type: "view", agentId: "a2" });
		state = reduceClientState(state, { type: "agents", agents: [agent({ id: "a1" })] });
		expect(state.viewing).toBe("a1");
		expect(state.agents.has("a2")).toBe(false);
	});

	test("re-receiving the same agent id preserves its accumulated transcript and attached flag", () => {
		let state = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		state = reduceClientState(state, { type: "attaching", agentId: "a1" });
		state = reduceClientState(state, { type: "line", agentId: "a1", seq: 1, text: "hello" });
		state = reduceClientState(state, { type: "agents", agents: [agent({ id: "a1", state: "busy" })] });
		const view = state.agents.get("a1");
		expect(view?.attached).toBe(true);
		expect(view?.lines).toEqual([{ seq: 1, text: "hello" }]);
		expect(view?.agent.state).toBe("busy");
	});
});

describe("reduceClientState: switching is a pure view change", () => {
	function twoAgentState(): ClientState {
		return reduceClientState(createClientState(), {
			type: "agents",
			agents: [agent({ id: "a1", cwd: "/repo/a" }), agent({ id: "a2", cwd: "/repo/b" })],
		});
	}

	test("view switches to a known agent id and touches nothing else", () => {
		const before = twoAgentState();
		const after = reduceClientState(before, { type: "view", agentId: "a2" });
		expect(after.viewing).toBe("a2");
		// The other agent's view object is untouched by reference.
		expect(after.agents.get("a1")).toBe(before.agents.get("a1"));
	});

	test("view to an unknown agent id is a no-op", () => {
		const before = twoAgentState();
		const after = reduceClientState(before, { type: "view", agentId: "does-not-exist" });
		expect(after).toBe(before);
	});

	test("viewNext(1) cycles forward and wraps past the last agent", () => {
		let state = twoAgentState();
		expect(state.viewing).toBe("a1");
		state = reduceClientState(state, { type: "viewNext", direction: 1 });
		expect(state.viewing).toBe("a2");
		state = reduceClientState(state, { type: "viewNext", direction: 1 });
		expect(state.viewing).toBe("a1");
	});

	test("viewNext(-1) cycles backward and wraps before the first agent", () => {
		let state = twoAgentState();
		state = reduceClientState(state, { type: "viewNext", direction: -1 });
		expect(state.viewing).toBe("a2");
	});

	test("switching never mutates lines, attached state, or agent identity", () => {
		let state = twoAgentState();
		state = reduceClientState(state, { type: "attaching", agentId: "a1" });
		state = reduceClientState(state, { type: "line", agentId: "a1", seq: 1, text: "turn continued" });
		const beforeSwitch = state.agents.get("a1");

		state = reduceClientState(state, { type: "view", agentId: "a2" });
		state = reduceClientState(state, { type: "view", agentId: "a1" });

		expect(state.agents.get("a1")).toBe(beforeSwitch);
		expect(state.agents.get("a1")?.lines).toEqual([{ seq: 1, text: "turn continued" }]);
	});
});

describe("reduceClientState: lines accumulate for a background agent", () => {
	test("lines append to an agent's view even while a different agent is being viewed", () => {
		let state = reduceClientState(createClientState(), {
			type: "agents",
			agents: [agent({ id: "a1" }), agent({ id: "a2" })],
		});
		state = reduceClientState(state, { type: "view", agentId: "a1" });
		state = reduceClientState(state, { type: "attaching", agentId: "a2" });
		state = reduceClientState(state, { type: "line", agentId: "a2", seq: 1, text: "background work" });
		state = reduceClientState(state, { type: "line", agentId: "a2", seq: 2, text: "still going" });

		expect(state.viewing).toBe("a1");
		expect(state.agents.get("a2")?.lines).toEqual([
			{ seq: 1, text: "background work" },
			{ seq: 2, text: "still going" },
		]);
	});

	test("a line for an unknown agent id is dropped, not attached to the wrong agent", () => {
		const before = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		const after = reduceClientState(before, { type: "line", agentId: "ghost", seq: 1, text: "x" });
		expect(after).toBe(before);
	});

	test("the transcript buffer is capped at MAX_LINES_PER_AGENT, dropping the oldest lines", () => {
		let state = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		for (let seq = 1; seq <= MAX_LINES_PER_AGENT + 5; seq++) {
			state = reduceClientState(state, { type: "line", agentId: "a1", seq, text: `line ${seq}` });
		}
		const lines = state.agents.get("a1")?.lines ?? [];
		expect(lines.length).toBe(MAX_LINES_PER_AGENT);
		expect(lines[0]?.seq).toBe(6);
		expect(lines.at(-1)?.seq).toBe(MAX_LINES_PER_AGENT + 5);
	});
});

describe("reduceClientState: approvals", () => {
	test("an approval attaches to its agent and resolves by matching requestId", () => {
		let state = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		state = reduceClientState(state, {
			type: "approval",
			agentId: "a1",
			requestId: "req-1",
			title: "Run bash",
			tool: "bash",
		});
		expect(state.agents.get("a1")?.pendingApproval).toEqual({
			requestId: "req-1",
			title: "Run bash",
			tool: "bash",
		});

		state = reduceClientState(state, { type: "approvalResolved", agentId: "a1", requestId: "req-1" });
		expect(state.agents.get("a1")?.pendingApproval).toBeNull();
	});

	test("resolving the wrong requestId leaves the pending approval untouched", () => {
		let state = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		state = reduceClientState(state, {
			type: "approval",
			agentId: "a1",
			requestId: "req-1",
			title: "Run bash",
			tool: "bash",
		});
		state = reduceClientState(state, { type: "approvalResolved", agentId: "a1", requestId: "stale-req" });
		expect(state.agents.get("a1")?.pendingApproval?.requestId).toBe("req-1");
	});
});

describe("reduceClientState: status and error", () => {
	test("status transitions record the connection state and an optional reason", () => {
		const state = reduceClientState(createClientState(), {
			type: "status",
			status: "reconnecting",
			reason: "ping timeout",
		});
		expect(state.status).toBe("reconnecting");
		expect(state.statusReason).toBe("ping timeout");
	});

	test("error records the last message without touching agent state", () => {
		const before = reduceClientState(createClientState(), { type: "agents", agents: [agent({ id: "a1" })] });
		const after = reduceClientState(before, { type: "error", message: "not connected" });
		expect(after.lastError).toBe("not connected");
		expect(after.agents).toBe(before.agents);
	});
});
