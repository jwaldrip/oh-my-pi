import type { Agent } from "@ompd/core/contracts";
import { el, formatTokens, setText } from "./dom.ts";

export interface AgentHubNode {
  agent: Agent;
  children: AgentHubNode[];
}

export interface AgentHubView {
  readonly element: HTMLElement;
  render(agents: readonly Agent[]): void;
  refreshClocks(): void;
}

/**
 * Builds a hierarchy from the daemon's roster without trusting ordering. A
 * dangling or cyclic parent link is rendered at the top rather than dropping
 * a live worker from the operator's view.
 */
export function agentHubTree(agents: readonly Agent[]): AgentHubNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, { agent, children: [] as AgentHubNode[] }]));
  const roots: AgentHubNode[] = [];
  const attached = new Set<string>();

  for (const node of byId.values()) {
    const parentId = node.agent.parentAgentId;
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (parent === undefined || parent === node || createsCycle(node, parent, byId)) continue;
    parent.children.push(node);
    attached.add(node.agent.id);
  }
  for (const node of byId.values()) {
    if (!attached.has(node.agent.id)) roots.push(node);
  }
  const compare = (left: AgentHubNode, right: AgentHubNode) =>
    left.agent.createdAt.localeCompare(right.agent.createdAt) || left.agent.name.localeCompare(right.agent.name);
  const sort = (nodes: AgentHubNode[]): void => {
    nodes.sort(compare);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

function createsCycle(
  node: AgentHubNode,
  parent: AgentHubNode,
  byId: ReadonlyMap<string, AgentHubNode>,
): boolean {
  const lineage = new Set([node.agent.id]);
  let ancestor: AgentHubNode | undefined = parent;
  while (ancestor !== undefined) {
    if (lineage.has(ancestor.agent.id)) return true;
    lineage.add(ancestor.agent.id);
    ancestor =
      ancestor.agent.parentAgentId === undefined ? undefined : byId.get(ancestor.agent.parentAgentId);
  }
  return false;
}

/**
 * `render` expects subagents only. The main agent is not shown, matching
 * OMP's own Agent Hub convention (`docs/agent-hub.md`): its conversation is
 * the ambient session view, already on screen as the top-level Bay strip.
 */
export function createAgentHub(): AgentHubView {
  const count = el("span", { class: "agent-hub-count", text: "0" });
  const list = el("ol", { class: "agent-hub-tree", attrs: { "aria-label": "Agent hierarchy" } });
  const empty = el("p", { class: "agent-hub-empty", text: "No subagents." });
  const element = el("section", {
    class: "agent-hub",
    attrs: { "aria-label": "Agent Hub" },
    children: [
      el("header", {
        class: "agent-hub-head",
        children: [el("h2", { class: "agent-hub-title", text: "Agent Hub" }), count],
      }),
      list,
      empty,
    ],
  });
  let latest: readonly Agent[] = [];

  function paint(): void {
    const tree = agentHubTree(latest);
    setText(count, String(latest.length));
    empty.hidden = tree.length > 0;
    list.hidden = tree.length === 0;
    list.replaceChildren(...tree.map((node) => branch(node, 1)));
  }

  return {
    element,
    render(agents): void {
      latest = agents;
      paint();
    },
    refreshClocks(): void {
      paint();
    },
  };
}

function branch(node: AgentHubNode, level: number): HTMLLIElement {
  const { agent } = node;
  const details = el("div", {
    class: "agent-hub-details",
    children: [
      el("div", {
        class: "agent-hub-line",
        children: [
          el("span", { class: "agent-hub-name", text: agent.name }),
          el("span", { class: "agent-hub-state", attrs: { "data-state": agent.state }, text: agent.state }),
        ],
      }),
      agent.taskTitle === undefined ? null : el("p", { class: "agent-hub-task", text: agent.taskTitle }),
      el("p", { class: "agent-hub-meta", text: metadata(agent) }),
    ],
  });
  const children =
    node.children.length === 0
      ? []
      : [
          el("ol", {
            class: "agent-hub-children",
            children: node.children.map((child) => branch(child, level + 1)),
          }),
        ];
  const item = el("li", {
    class: "agent-hub-node",
    attrs: { "aria-level": String(level) },
    children: [details, ...children],
  });
  return item;
}

function metadata(agent: Agent): string {
  const runtimeMs = agent.metrics?.durationMs ?? Math.max(0, Date.now() - Date.parse(agent.createdAt));
  const parts = [agent.model ?? "model unknown", `runtime ${formatRuntime(runtimeMs)}`];
  if (agent.metrics !== undefined) parts.push(`${formatTokens(agent.metrics.usedTokens)} tokens`);
  if (agent.metrics?.costAmount !== undefined) parts.push(`cost ${agent.metrics.costAmount.toFixed(4)}`);
  return parts.join(" · ");
}

function formatRuntime(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

