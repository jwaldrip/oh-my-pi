import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import type { Agent, AgentState } from "@ompd/core/contracts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke } from "../design/tokens.ts";

export interface AgentHubNode {
  agent: Agent;
  children: AgentHubNode[];
}

/**
 * Turns the daemon's flat agent registry into a stable forest. A malformed
 * parent reference never hides a worker: it remains a root until the daemon
 * sends the next coherent snapshot.
 */
export function agentHubTree(agents: readonly Agent[]): AgentHubNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, { agent, children: [] as AgentHubNode[] }]));
  const roots: AgentHubNode[] = [];
  const attached = new Set<string>();

  for (const node of byId.values()) {
    const parent =
      node.agent.parentAgentId === undefined ? undefined : byId.get(node.agent.parentAgentId);
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

export interface AgentHubProps {
  /**
   * Subagents only. The main agent is not listed here, matching OMP's own
   * Agent Hub convention (`docs/agent-hub.md`): its conversation is the
   * ambient session view, already on screen as the top-level Fleet row.
   */
  agents: readonly Agent[];
  /** A fixed clock makes runtime output deterministic for callers and tests. */
  now?: number;
  testID?: string;
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

export function AgentHub({ agents, now = Date.now(), testID = "agent-hub" }: AgentHubProps): JSX.Element {
  const tree = agentHubTree(agents);
  return (
    <View style={styles.hub} testID={testID} accessibilityLabel="Agent hierarchy">
      <View style={styles.heading}>
        <Kicker color={ink.muted}>AGENT HUB</Kicker>
        <Label color={ink.plain}>{`${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}</Label>
      </View>
      {tree.length === 0 ? (
        <Body color={ink.muted} testID="agent-hub-empty">
          No subagents.
        </Body>
      ) : (
        tree.map((node) => <AgentHubBranch key={node.agent.id} node={node} depth={0} now={now} />)
      )}
    </View>
  );
}

function AgentHubBranch({ node, depth, now }: { node: AgentHubNode; depth: number; now: number }): JSX.Element {
  const { agent } = node;
  const metrics = agent.metrics;
  const runtimeMs = metrics?.durationMs ?? Math.max(0, now - Date.parse(agent.createdAt));
  const status = statusSignal(agent.state);
  const metricsLabel = metrics === undefined ? `runtime ${formatRuntime(runtimeMs)}` : `${metrics.usedTokens.toLocaleString()} tokens · ${formatRuntime(runtimeMs)}`;
  const costLabel = metrics?.costAmount === undefined ? null : `cost ${metrics.costAmount.toFixed(4)}`;

  return (
    <View style={[styles.branch, depth > 0 && styles.nested]} testID={`agent-hub-${agent.id}`}>
      <View style={styles.row}>
        <View style={[styles.status, { backgroundColor: signalWash[status] }]}>
          <Label color={signal[status]}>{agent.state}</Label>
        </View>
        <View style={styles.details}>
          <Body color={ink.bright}>{agent.name}</Body>
          {agent.taskTitle === undefined ? null : <Label color={ink.plain}>{agent.taskTitle}</Label>}
          <View style={styles.meta}>
            {agent.model === undefined ? null : <Kicker color={ink.muted}>{agent.model}</Kicker>}
            <Kicker color={ink.muted}>{metricsLabel}</Kicker>
            {costLabel === null ? null : <Kicker color={ink.muted}>{costLabel}</Kicker>}
          </View>
        </View>
      </View>
      {node.children.map((child) => (
        <AgentHubBranch key={child.agent.id} node={child} depth={depth + 1} now={now} />
      ))}
    </View>
  );
}

function statusSignal(state: AgentState): keyof typeof signal {
  if (state === "busy") return "amber";
  if (state === "idle") return "sage";
  if (state === "waiting" || state === "provisioning" || state === "starting") return "ochre";
  if (state === "failed") return "oxide";
  return "slate";
}

function formatRuntime(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const styles = StyleSheet.create({
  hub: {
    gap: space.snug,
    padding: space.wide,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  branch: { gap: space.tight },
  nested: { marginLeft: space.wide, paddingLeft: space.snug, borderLeftWidth: stroke.hair, borderLeftColor: ground.edge },
  row: { flexDirection: "row", gap: space.snug, alignItems: "flex-start" },
  status: { minWidth: 64, paddingHorizontal: space.tight, paddingVertical: space.hair, alignItems: "center" },
  details: { flex: 1, gap: space.hair },
  meta: { flexDirection: "row", flexWrap: "wrap", columnGap: space.snug, rowGap: space.hair },
});
