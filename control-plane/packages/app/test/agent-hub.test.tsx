import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";

const { agentHubTree } = await import("../src/components/AgentHub.tsx");

const createdAt = "2026-08-13T08:00:00.000Z";
const host = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };
const agents: Agent[] = [
  {
    id: "agt_main",
    name: "Primary",
    state: "busy",
    host,
    cwd: "/workspace",
    createdAt,
    lastActiveAt: createdAt,
    labels: {},
  },
  {
    id: "agt_scout",
    name: "Policy Scout",
    state: "idle",
    host,
    cwd: "/workspace",
    createdAt: "2026-08-13T08:01:00.000Z",
    lastActiveAt: createdAt,
    parentAgentId: "agt_main",
    taskTitle: "Inspect the permission path",
    model: "anthropic/claude-sonnet-5",
    metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
    labels: {},
  },
  {
    id: "agt_reviewer",
    name: "Review",
    state: "waiting",
    host,
    cwd: "/workspace",
    createdAt: "2026-08-13T08:02:00.000Z",
    lastActiveAt: createdAt,
    parentAgentId: "agt_scout",
    taskTitle: "Check authorization edges",
    model: "openai/gpt-5.4",
    metrics: { usedTokens: 240, durationMs: 5_000 },
    labels: {},
  },
];

describe("AgentHub", () => {
  test("carries assignment, model, runtime, and cost through the nested tree", () => {
    const [primary] = agentHubTree(agents);
    const scout = primary?.children[0]?.agent;
    const reviewer = primary?.children[0]?.children[0]?.agent;

    expect(scout).toMatchObject({
      name: "Policy Scout",
      taskTitle: "Inspect the permission path",
      model: "anthropic/claude-sonnet-5",
      metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
    });
    expect(reviewer).toMatchObject({
      name: "Review",
      taskTitle: "Check authorization edges",
      model: "openai/gpt-5.4",
      metrics: { usedTokens: 240, durationMs: 5_000 },
    });
  });

  test("builds a parent-child tree from flat daemon events", () => {
    const [primary] = agentHubTree(agents);
    expect(primary?.agent.id).toBe("agt_main");
    expect(primary?.children[0]?.agent.id).toBe("agt_scout");
    expect(primary?.children[0]?.children[0]?.agent.id).toBe("agt_reviewer");
  });

  test("callers exclude the main agent so it is not duplicated with the Fleet row", () => {
    // The exact filter Console.tsx and main.ts apply before calling AgentHub/agentHubTree.
    const subagentsOnly = agents.filter((agent) => agent.parentAgentId !== undefined);
    const roots = agentHubTree(subagentsOnly);

    expect(roots.map((node) => node.agent.id)).toEqual(["agt_scout"]);
    expect(roots[0]?.children[0]?.agent.id).toBe("agt_reviewer");
  });
});
