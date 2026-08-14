import {
  AgentRegistry,
  type AgentHistorySummary,
  type AgentKind,
  type AgentRef,
  type AgentStatus,
} from "../../registry/agent-registry";

export { AgentRegistry } from "../../registry/agent-registry";

/** The AgentRegistry shape sent to ACP clients as an extension notification. */
export interface AgentRegistrySnapshot {
  id: string;
  displayName: string;
  kind: Exclude<AgentKind, "advisor">;
  parentId?: string;
  /** ACP session of the parent, when it is still live. */
  parentSessionId?: string;
  status: AgentStatus;
  createdAt: string;
  lastActiveAt: string;
  taskTitle?: string;
  model?: string;
  metrics: { usedTokens: number; costAmount?: number; durationMs: number };
}

/**
 * Make a wire-safe snapshot rather than passing AgentRegistry refs across the
 * transport. Refs carry a live AgentSession, which is process-local and must
 * never be serialized to a control-plane client.
 */
export function snapshotAgentRegistry(registry: AgentRegistry, now = Date.now()): AgentRegistrySnapshot[] {
  return registry
    .list()
    .filter((ref): ref is AgentRef & { kind: Exclude<AgentKind, "advisor"> } => ref.kind !== "advisor")
    .map((ref) => snapshot(ref, registry, now));
}

function snapshot(ref: AgentRef & { kind: Exclude<AgentKind, "advisor"> }, registry: AgentRegistry, now: number): AgentRegistrySnapshot {
  const metrics = metricsFor(ref.history, ref.createdAt, now);
  const parent = ref.parentId === undefined ? undefined : registry.get(ref.parentId);
  const result: AgentRegistrySnapshot = {
    id: ref.id,
    displayName: ref.displayName,
    kind: ref.kind,
    parentId: ref.parentId,
    parentSessionId: parent?.session?.sessionId,
    status: ref.status,
    createdAt: new Date(ref.createdAt).toISOString(),
    lastActiveAt: new Date(ref.lastActivity).toISOString(),
    metrics,
  };
  const taskTitle = ref.history?.taskTitle ?? ref.activity;
  if (taskTitle !== undefined) result.taskTitle = taskTitle;
  if (ref.history?.resolvedModel !== undefined) result.model = ref.history.resolvedModel;
  if (result.parentId === undefined) delete result.parentId;
  if (result.parentSessionId === undefined) delete result.parentSessionId;
  return result;
}

function metricsFor(history: AgentHistorySummary | undefined, createdAt: number, now: number): AgentRegistrySnapshot["metrics"] {
  const metrics = history?.metrics;
  const result: AgentRegistrySnapshot["metrics"] = {
    usedTokens: metrics?.tokens ?? 0,
    durationMs: metrics?.durationMs ?? Math.max(0, now - createdAt),
  };
  if (metrics !== undefined) result.costAmount = metrics.cost;
  return result;
}

/**
 * Mirrors AgentRegistry changes over one ACP connection. A full snapshot on
 * every lifecycle or metadata mutation makes reconnect recovery simple and
 * lets removal be observed as absence rather than as an untrusted imperative.
 */
export class AgentRegistryAcpBridge {
  readonly #unsubscribe: () => void;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly send: (agents: AgentRegistrySnapshot[]) => void | Promise<void>,
  ) {
    this.#unsubscribe = registry.onChange(() => this.publish());
  }

  publish(): void {
    try {
      void Promise.resolve(this.send(snapshotAgentRegistry(this.registry))).catch(() => {});
    } catch {
      // ACP may be closing while a final registry event arrives. The owner
      // tears this bridge down during connection disposal, so a dropped stale
      // snapshot is preferable to allowing observability to crash the agent.
    }
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
