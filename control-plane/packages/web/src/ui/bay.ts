/**
 * The bay: one strip per agent.
 *
 * A strip is a fixed-pitch data block with a coloured edge. The edge is the
 * state, readable across a room; the block is everything you need before you
 * decide which agent to open. It is the densest surface in the app on purpose,
 * because the whole point of a bay is that you take it in at a glance rather
 * than reading it.
 */

import type { Agent, AgentId, AgentState } from "@ompd/core/contracts";
import { el, elapsed, setText, shortenPath, toggleClass } from "./dom.ts";

export interface StripStats {
  /** Context consumed, 0 to 100. Null before the agent reports usage. */
  contextPct: number | null;
  cost: string | null;
  tools: number;
  running: number;
  clearances: number;
}

export interface BayOptions {
  onSelect(agentId: AgentId): void;
}

export interface BayView {
  readonly element: HTMLElement;
  render(agents: readonly Agent[]): void;
  setSelected(agentId: AgentId | null): void;
  setStats(agentId: AgentId, stats: StripStats): void;
  /** Repaints the running clocks. Called on a one-second tick. */
  refreshClocks(): void;
  focusAgent(agentId: AgentId): void;
  /** The strip at the top of the bay: the one most in need of attention. */
  topAgent(): AgentId | null;
}

interface Strip {
  agent: Agent;
  root: HTMLButtonElement;
  callsign: HTMLElement;
  state: HTMLElement;
  origin: HTMLElement;
  clock: HTMLElement;
  context: HTMLElement;
  cost: HTMLElement;
  tools: HTMLElement;
  hold: HTMLElement;
}

/** Ordering in the bay. Work that needs a human sorts to the top. */
const STATE_RANK: Record<AgentState, number> = {
  waiting: 0,
  busy: 1,
  failed: 2,
  idle: 3,
  starting: 4,
  provisioning: 5,
  stopped: 6,
};

const STATE_LABELS: Record<AgentState, string> = {
  provisioning: "provisioning",
  starting: "starting",
  idle: "idle",
  busy: "working",
  waiting: "hold",
  stopped: "stopped",
  failed: "failed",
};

export function createBay(options: BayOptions): BayView {
  const count = el("span", { class: "bay-count", text: "0" });
  const list = el("ul", { class: "bay-list", attrs: { "aria-label": "Agent strips" } });
  const empty = el("p", {
    class: "bay-empty",
    text: "No agents. Create one with ompd agent create.",
  });

  const element = el("nav", {
    class: "bay",
    attrs: { "aria-label": "Bay" },
    children: [
      el("header", {
        class: "bay-head",
        children: [el("h2", { class: "bay-title", text: "Bay" }), count],
      }),
      list,
      empty,
    ],
  });

  const strips = new Map<AgentId, Strip>();
  let selected: AgentId | null = null;
  /** Rendered order, so the shell can ask which strip is on top. */
  let order: AgentId[] = [];

  function build(agent: Agent): Strip {
    const callsign = el("span", { class: "strip-callsign", text: agent.name });
    const state = el("span", { class: "strip-state", text: STATE_LABELS[agent.state] });
    const origin = el("span", { class: "strip-origin", text: shortenPath(agent.cwd) });
    const clock = el("span", { class: "strip-clock", text: elapsed(agent.lastActiveAt) });
    const context = el("span", { class: "cell", text: "ctx --" });
    const cost = el("span", { class: "cell", text: "--" });
    const tools = el("span", { class: "cell", text: "0 tools" });
    const hold = el("span", { class: "cell cell-hold", text: "" });
    hold.hidden = true;

    const root = el("button", {
      class: "strip",
      attrs: { type: "button", "data-state": agent.state, title: agent.cwd },
      children: [
        el("span", { class: "strip-tint", attrs: { "aria-hidden": "true" } }),
        el("span", {
          class: "strip-main",
          children: [
            el("span", { class: "strip-line strip-line-head", children: [callsign, state] }),
            el("span", { class: "strip-line", children: [origin, clock] }),
            el("span", { class: "strip-line strip-data", children: [context, cost, tools, hold] }),
          ],
        }),
      ],
    });
    root.addEventListener("click", () => {
      options.onSelect(agent.id);
    });

    return { agent, root, callsign, state, origin, clock, context, cost, tools, hold };
  }

  function paint(strip: Strip, agent: Agent): void {
    strip.agent = agent;
    setText(strip.callsign, agent.name);
    setText(strip.state, STATE_LABELS[agent.state]);
    setText(strip.origin, shortenPath(agent.cwd));
    setText(strip.clock, elapsed(agent.lastActiveAt));
    strip.root.setAttribute("data-state", agent.state);
    strip.root.setAttribute("title", agent.cwd);
  }

  function render(agents: readonly Agent[]): void {
    setText(count, String(agents.length));
    empty.hidden = agents.length > 0;
    list.hidden = agents.length === 0;

    const ordered = [...agents].sort((left, right) => {
      const rank = STATE_RANK[left.state] - STATE_RANK[right.state];
      if (rank !== 0) return rank;
      return Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);
    });

    order = ordered.map((agent) => agent.id);
    const live = new Set<AgentId>(order);
    const rows: HTMLElement[] = [];
    for (const agent of ordered) {
      const existing = strips.get(agent.id);
      if (existing === undefined) {
        const strip = build(agent);
        strips.set(agent.id, strip);
        rows.push(el("li", { class: "bay-item", children: [strip.root] }));
        continue;
      }
      paint(existing, agent);
      const item = existing.root.parentElement;
      if (item instanceof HTMLElement) rows.push(item);
    }

    for (const [agentId, strip] of strips) {
      if (live.has(agentId)) continue;
      strip.root.parentElement?.remove();
      strips.delete(agentId);
    }

    // Replacing with the existing nodes reorders without rebuilding them, so a
    // strip that moves up the bay keeps its focus and its live clock.
    list.replaceChildren(...rows);
    setSelected(selected);
  }

  function setSelected(agentId: AgentId | null): void {
    selected = agentId;
    for (const [id, strip] of strips) {
      const on = id === agentId;
      toggleClass(strip.root, "is-selected", on);
      if (on) {
        strip.root.setAttribute("aria-current", "true");
        continue;
      }
      strip.root.removeAttribute("aria-current");
    }
  }

  return {
    element,
    render,
    setSelected,
    setStats(agentId: AgentId, stats: StripStats): void {
      const strip = strips.get(agentId);
      if (strip === undefined) return;
      setText(strip.context, stats.contextPct === null ? "ctx --" : `ctx ${stats.contextPct.toFixed(1)}%`);
      setText(strip.cost, stats.cost ?? "--");
      setText(strip.tools, stats.running > 0 ? `${stats.running} running` : `${stats.tools} tools`);
      toggleClass(strip.tools, "cell-live", stats.running > 0);
      strip.hold.hidden = stats.clearances === 0;
      setText(strip.hold, stats.clearances === 1 ? "1 clearance" : `${stats.clearances} clearances`);
    },
    refreshClocks(): void {
      const now = Date.now();
      for (const strip of strips.values()) setText(strip.clock, elapsed(strip.agent.lastActiveAt, now));
    },
    focusAgent(agentId: AgentId): void {
      strips.get(agentId)?.root.focus();
    },
    topAgent(): AgentId | null {
      return order[0] ?? null;
    },
  };
}
