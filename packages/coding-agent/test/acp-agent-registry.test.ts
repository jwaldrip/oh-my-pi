import { afterEach, describe, expect, test } from "bun:test";
import {
	AgentRegistry,
	AgentRegistryAcpBridge,
	type AgentRegistrySnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/acp/agent-registry-events";

const registry = (): AgentRegistry => {
	AgentRegistry.resetGlobalForTests();
	return AgentRegistry.global();
};

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("ACP AgentRegistry snapshots", () => {
	test("publish child spawn, status, lineage, model, assignment, and streaming metrics", async () => {
		const local = registry();
		const snapshots: AgentRegistrySnapshot[][] = [];
		const bridge = new AgentRegistryAcpBridge(local, next => {
			snapshots.push(next);
		});

		local.register({ id: "Main", displayName: "Primary", kind: "main", session: null });
		local.register({
			id: "PolicyScout",
			displayName: "scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			history: {
				taskTitle: "Inspect the permission path",
				resolvedModel: "anthropic/claude-sonnet-5",
				metrics: { tokens: 1_200, requests: 2, tools: 3, cost: 0.0175, durationMs: 65_000 },
			},
		});

		const spawned = snapshots.at(-1)?.find(agent => agent.id === "PolicyScout");
		expect(spawned).toMatchObject({
			parentId: "Main",
			taskTitle: "Inspect the permission path",
			model: "anthropic/claude-sonnet-5",
			metrics: { usedTokens: 1_200, costAmount: 0.0175, durationMs: 65_000 },
		});

		local.setStatus("PolicyScout", "parked");
		local.setHistory("PolicyScout", {
			metrics: { tokens: 1_560, requests: 3, tools: 4, cost: 0.024, durationMs: 91_000 },
		});

		const updated = snapshots.at(-1)?.find(agent => agent.id === "PolicyScout");
		expect(updated).toMatchObject({
			status: "parked",
			metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
		});
		bridge.dispose();
	});
});
