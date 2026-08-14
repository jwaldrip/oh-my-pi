import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { agentHubTree } from "../src/ui/agent-hub.ts";

const host = { kind: "local" as const, id: "1", spec: { kind: "local" as const } };

function agent(id: string, parentAgentId?: string): Agent {
  return {
    id,
    name: id,
    state: "idle",
    host,
    cwd: "/workspace",
    createdAt: `2026-08-13T08:0${id.length}:00.000Z`,
    lastActiveAt: "2026-08-13T08:00:00.000Z",
    labels: {},
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  };
}

describe("web Agent Hub hierarchy", () => {
  test("nests a child tree while leaving a dangling parent visible", () => {
    const tree = agentHubTree([
      agent("root"),
      agent("scout", "root"),
      agent("review", "scout"),
      agent("orphan", "gone"),
    ]);

    expect(tree.map((node) => node.agent.id)).toEqual(["root", "orphan"]);
    expect(tree[0]?.children[0]?.agent.id).toBe("scout");
    expect(tree[0]?.children[0]?.children[0]?.agent.id).toBe("review");
  });

  test("does not recurse through a cyclic lineage", () => {
    const tree = agentHubTree([agent("a", "b"), agent("b", "a")]);
    expect(tree.map((node) => node.agent.id).sort()).toEqual(["a", "b"]);
  });
});
