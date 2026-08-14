/**
 * Fan-out for supervisor events.
 *
 * `Supervisor` takes its event sink at construction and the gateway is built
 * after it, so something has to stand between the two. Making that seam a real
 * fan-out rather than a mutable back-reference also means a second consumer can
 * observe the same stream without the supervisor knowing about either of them,
 * which is what a voice bridge or a routine scheduler needs.
 */

import type { Agent, AgentId } from "@ompd/core";
import type { PendingApproval, PendingPlanReview, SupervisorEvents } from "../supervisor.ts";

/**
 * A turn's answer as speakable prose.
 *
 * Its own channel rather than a `SupervisorEvents` member: the supervisor
 * streams what an agent emitted, and this is a rendering of what a turn came
 * to, produced above it by whoever knows how to summarise. `seq` is the last
 * update the text derives from, so a client can tell turns apart.
 */
export interface SayEvent {
  agentId: AgentId;
  seq: number;
  text: string;
}

export type SayListener = (event: SayEvent) => void;

export class GatewayEvents implements SupervisorEvents {
  #listeners = new Set<SupervisorEvents>();
  #sayListeners = new Set<SayListener>();

  /** Subscribe. The returned function unsubscribes. */
  add(listener: SupervisorEvents): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onUpdate(agentId: AgentId, seq: number, update: unknown): void {
    for (const listener of this.#listeners) listener.onUpdate?.(agentId, seq, update);
  }

  onAgentsChanged(agents: Agent[]): void {
    for (const listener of this.#listeners) listener.onAgentsChanged?.(agents);
  }

  onApprovalNeeded(approval: Omit<PendingApproval, "resolve">): void {
    for (const listener of this.#listeners) listener.onApprovalNeeded?.(approval);
  }

  onPlanReviewNeeded(review: Omit<PendingPlanReview, "resolve">): void {
    for (const listener of this.#listeners) listener.onPlanReviewNeeded?.(review);
  }

  /** Subscribe to spoken-form summaries. The returned function unsubscribes. */
  addSayListener(listener: SayListener): () => void {
    this.#sayListeners.add(listener);
    return () => {
      this.#sayListeners.delete(listener);
    };
  }

  emitSay(event: SayEvent): void {
    for (const listener of this.#sayListeners) listener(event);
  }
}
