/**
 * The instrument surfaces: the data block that sits under every log, and the
 * rack that expands it when there is room.
 *
 * These carry the numbers that prove you are looking at a live agent rather
 * than a mock: how much of the context window is gone, what the turn has cost,
 * how many tools are in flight, how long the current turn has been running.
 * The data block is never hidden, at any width.
 */

import type { AgentState } from "@ompd/core/contracts";
import type { Usage } from "../session/model.ts";
import { el, formatMoney, formatTokens, setText, toggleClass } from "./dom.ts";
import { icon } from "./icons.ts";
import type { GlyphName } from "./icons.ts";

export interface Readings {
  cwd: string;
  state: AgentState;
  usage: Usage | null;
  /** Milliseconds the turn has run, or the last one took. Null before any turn. */
  turnMs: number | null;
  /** Whether `turnMs` is still counting up. */
  turnLive: boolean;
  seq: number;
  tools: number;
  running: number;
  failed: number;
  clearances: number;
  commands: number;
  model: string | null;
}

export interface DataBlockView {
  readonly element: HTMLElement;
  render(readings: Readings): void;
}

export interface RackView {
  readonly element: HTMLElement;
  /** Where the plan panel lives when the rack is on screen. */
  readonly planHost: HTMLElement;
  render(readings: Readings): void;
}

const STATE_LABELS: Record<AgentState, string> = {
  provisioning: "provisioning",
  starting: "starting",
  idle: "idle",
  busy: "working",
  waiting: "holding",
  stopped: "stopped",
  failed: "failed",
};

interface Cell {
  root: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
}

function cell(key: string, extra = ""): Cell {
  const value = el("span", { class: "db-value" });
  const sub = el("span", { class: "db-sub" });
  const root = el("div", {
    class: extra.length > 0 ? `db-cell ${extra}` : "db-cell",
    children: [el("span", { class: "db-key", text: key }), value, sub],
  });
  return { root, value, sub };
}

/** A proportion bar. Kept out of `<meter>`, which cannot be styled honestly. */
interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
}

function bar(): Bar {
  const fill = el("span", { class: "bar-fill" });
  const root = el("span", {
    class: "bar",
    attrs: { role: "img", "aria-label": "context used" },
    children: [fill],
  });
  return { root, fill };
}

function paintBar(instance: Bar, ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  instance.fill.style.inlineSize = `${(clamped * 100).toFixed(1)}%`;
  const level = clamped >= 0.9 ? "critical" : clamped >= 0.7 ? "high" : "normal";
  instance.root.setAttribute("data-level", level);
}

export function createDataBlock(): DataBlockView {
  const origin = cell("origin", "db-origin");
  const state = cell("state");
  const context = cell("context");
  const spend = cell("spend");
  const turn = cell("turn");

  const lamp = el("span", { class: "lamp" });
  state.value.append(lamp, el("span", { class: "db-state-text", text: "--" }));
  const stateText = state.value.querySelector<HTMLElement>(".db-state-text");

  const contextBar = bar();
  const contextPct = el("span", { class: "db-pct", text: "--" });
  context.value.append(contextPct, contextBar.root);

  const element = el("footer", {
    class: "datablock",
    attrs: { "aria-label": "Session readouts" },
    children: [origin.root, state.root, context.root, spend.root, turn.root],
  });

  return {
    element,
    render(readings: Readings): void {
      setText(origin.value, readings.cwd);
      origin.root.setAttribute("title", readings.cwd);
      setText(origin.sub, readings.model ?? "");
      origin.sub.hidden = readings.model === null;

      element.setAttribute("data-state", readings.state);
      if (stateText !== null) setText(stateText, STATE_LABELS[readings.state]);
      setText(state.sub, readings.running > 0 ? `${readings.running} in flight` : `${readings.tools} tools`);

      const usage = readings.usage;
      if (usage === null || usage.size === 0) {
        setText(contextPct, "--");
        paintBar(contextBar, 0);
        setText(context.sub, "awaiting first turn");
      } else {
        const ratio = usage.used / usage.size;
        setText(contextPct, `${(ratio * 100).toFixed(1)}%`);
        paintBar(contextBar, ratio);
        setText(context.sub, `${formatTokens(usage.used)} / ${formatTokens(usage.size)}`);
      }

      setText(spend.value, usage === null ? "--" : formatMoney(usage.costAmount, usage.costCurrency));
      setText(spend.sub, usage === null ? "no meter yet" : "this session");

      if (readings.turnMs === null) {
        setText(turn.value, "--");
        setText(turn.sub, `seq ${readings.seq}`);
      } else {
        const seconds = Math.round(readings.turnMs / 1000);
        setText(turn.value, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
        setText(turn.sub, readings.turnLive ? `seq ${readings.seq} · live` : `seq ${readings.seq} · last`);
      }
    },
  };
}

interface Gauge {
  root: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
}

function gauge(glyph: GlyphName, label: string, extra: Node[] = []): Gauge {
  const value = el("span", { class: "gauge-value", text: "--" });
  const sub = el("span", { class: "gauge-sub" });
  const root = el("section", {
    class: "gauge",
    children: [
      el("h3", {
        class: "gauge-label",
        children: [icon(glyph), el("span", { text: label })],
      }),
      value,
      ...extra,
      sub,
    ],
  });
  return { root, value, sub };
}

export function createRack(): RackView {
  const loadBar = bar();
  const load = gauge("load", "context load", [loadBar.root]);
  const spend = gauge("cost", "spend");
  const activity = gauge("activity", "tool activity");
  const clearances = gauge("clearance", "clearances");
  const palette = gauge("commands", "palette");

  const planHost = el("div", { class: "rack-plan" });

  const element = el("aside", {
    class: "rack",
    attrs: { "aria-label": "Session instruments" },
    children: [planHost, load.root, spend.root, activity.root, clearances.root, palette.root],
  });

  return {
    element,
    planHost,
    render(readings: Readings): void {
      const usage = readings.usage;
      if (usage === null || usage.size === 0) {
        setText(load.value, "--");
        setText(load.sub, "no usage reported yet");
        paintBar(loadBar, 0);
      } else {
        const ratio = usage.used / usage.size;
        setText(load.value, `${(ratio * 100).toFixed(1)}%`);
        setText(load.sub, `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens`);
        paintBar(loadBar, ratio);
      }

      setText(spend.value, usage === null ? "--" : formatMoney(usage.costAmount, usage.costCurrency));
      setText(spend.sub, usage === null ? "billing starts with the first turn" : `${usage.costCurrency} this session`);

      setText(activity.value, String(readings.tools));
      setText(
        activity.sub,
        readings.failed > 0
          ? `${readings.running} running · ${readings.failed} failed`
          : `${readings.running} running`,
      );
      toggleClass(activity.root, "is-alarm", readings.failed > 0);

      setText(clearances.value, readings.clearances === 0 ? "clear" : String(readings.clearances));
      setText(clearances.sub, readings.clearances === 0 ? "nothing held" : "waiting on you");
      toggleClass(clearances.root, "is-hold", readings.clearances > 0);

      setText(palette.value, String(readings.commands));
      setText(palette.sub, readings.commands === 0 ? "none advertised" : "type / to filter");
    },
  };
}
