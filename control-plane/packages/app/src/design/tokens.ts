/**
 * The vocabulary every surface in this app draws from.
 *
 * Two rules make this file worth having. Colour is meaning: a hue is only in
 * the palette because it says something an operator has to read at a glance,
 * and nothing here is decorative. And the ground is warm graphite rather than
 * the blue-black every component kit ships, because an operator stares at this
 * for hours and a cold ground under amber signals reads as a dashboard warning
 * light rather than a working surface.
 *
 * No gradients, no translucency, no rounded corners. A strip either is or is
 * not, and a soft edge on a failure state is a lie about how the run went.
 */

import type { AgentState } from "@ompd/core/contracts";
import type { ToolStatus } from "../session/model.ts";

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Warm graphite, from deepest to lightest. Every step shares a hue so stacking
 * two of them reads as depth rather than as a different material.
 */
export const ground = {
  /** Behind everything. The window itself. */
  base: "#141310",
  /** A panel sitting on the base: the bay, the composer, the readout. */
  surface: "#1C1A16",
  /** A card sitting on a panel: a tool call, an approval. */
  raised: "#24211B",
  /** Pressed, selected, or otherwise held. */
  active: "#2E2A22",
  /** Hairlines. Structure, not decoration. */
  line: "#332F27",
  /** A heavier rule where a section genuinely ends. */
  edge: "#403A30",
} as const;

/**
 * Type colours. Four steps is enough: anything finer stops being a hierarchy
 * and starts being an accident.
 */
export const ink = {
  /** Primary reading text. */
  bright: "#EDE7DA",
  /** Labels, secondary prose. */
  plain: "#B5AD9D",
  /** Units, timestamps, the quiet half of a data pair. */
  muted: "#847C6D",
  /** Present but not to be read unless looked for. */
  faint: "#5A5449",
  /** On top of a filled signal swatch. */
  inverse: "#141310",
} as const;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Six colours, six meanings, no overlap. A seventh would mean two of them are
 * saying the same thing and the operator now has to remember which.
 */
export const signal = {
  /** Working. A turn is in flight and tokens are moving. */
  amber: "#E0A33A",
  /** Ready. Idle, healthy, waiting on a person rather than on itself. */
  sage: "#8FA97B",
  /** Holding. Blocked on something that is not an error: a clearance, a host. */
  ochre: "#C1662F",
  /** Failed. A run that will not finish without someone. */
  oxide: "#B4462F",
  /** Cold. Stopped on purpose, transcript retained, nothing running. */
  slate: "#7A828A",
  /** Reasoning. Thought rather than reply; never the same weight as an answer. */
  violet: "#8B7BC4",
} as const;

export type SignalName = keyof typeof signal;

/**
 * The dim companion to each signal, for a fill behind text of that colour.
 * Mixed against `ground.surface` rather than lightened, so a filled chip sits
 * in the same material as the panel under it.
 */
export const signalWash = {
  amber: "#31281A",
  sage: "#232A1F",
  ochre: "#2D1F16",
  oxide: "#2B1A16",
  slate: "#20242A",
  violet: "#231F30",
} as const satisfies Record<SignalName, string>;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * Faces are referenced by their PostScript name, which is what iOS and macOS
 * match on. Android matches the filename, and the vendored files are named to
 * agree with their PostScript name for exactly that reason.
 *
 * `weight` is deliberately absent from the styles below: naming a face and a
 * numeric weight at the same time makes Android synthesise a bold on top of a
 * face that already is one.
 */
export const face = {
  regular: "Archivo-Regular",
  medium: "Archivo-Medium",
  semibold: "Archivo-SemiBold",
  mono: "IBMPlexMono-Regular",
  monoMedium: "IBMPlexMono-Medium",
} as const;

/**
 * A type scale, not a set of sizes. Every entry names the job it does, so a
 * surface picks by role and the ramp stays consistent across five platforms
 * with five different default metrics.
 */
export const type = {
  /** Section kickers and the smallest labels. Tracked out to stay legible. */
  kicker: { fontFamily: face.medium, fontSize: 11, letterSpacing: 1.1, lineHeight: 14 },
  /** Field labels and chip text. */
  label: { fontFamily: face.medium, fontSize: 12, letterSpacing: 0.3, lineHeight: 16 },
  /** Body prose: transcript messages, descriptions. */
  body: { fontFamily: face.regular, fontSize: 15, lineHeight: 22 },
  /** A card's headline: an agent name, a tool title. */
  title: { fontFamily: face.semibold, fontSize: 16, lineHeight: 22 },
  /** The one thing on a screen that is the screen. */
  display: { fontFamily: face.semibold, fontSize: 22, lineHeight: 28 },
  /** Numbers a person compares against other numbers. */
  data: { fontFamily: face.monoMedium, fontSize: 13, letterSpacing: 0.2, lineHeight: 18 },
  /** Command output, paths, anything where alignment carries meaning. */
  code: { fontFamily: face.mono, fontSize: 12, lineHeight: 18 },
} as const;

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

/** A four-point grid. Every gap and inset in the app is one of these. */
export const space = {
  hair: 2,
  tight: 4,
  snug: 8,
  step: 12,
  wide: 16,
  loose: 24,
  gulf: 32,
} as const;

/**
 * Square, everywhere. Kept as a named token rather than a literal so the rule
 * is visible and a future rounding decision is one edit rather than a hunt.
 */
export const radius = 0;

/** Hairline structure. `heavy` is a rule; `hair` is a division. */
export const stroke = { hair: 1, heavy: 2 } as const;

/** Smallest square a finger can reliably hit. */
export const TOUCH_TARGET = 44;

// ---------------------------------------------------------------------------
// Meaning
// ---------------------------------------------------------------------------

/**
 * Agent state to signal. This mapping is the reason the palette has six
 * entries: each state a person has to act on differently gets its own colour,
 * and the two that need nothing (`stopped`) share the one that means so.
 */
const AGENT_SIGNALS: Record<AgentState, SignalName> = {
  provisioning: "ochre",
  starting: "ochre",
  idle: "sage",
  busy: "amber",
  waiting: "ochre",
  stopped: "slate",
  failed: "oxide",
};

export function agentSignal(state: AgentState): SignalName {
  return AGENT_SIGNALS[state] ?? "slate";
}

const TOOL_SIGNALS: Record<ToolStatus, SignalName> = {
  pending: "slate",
  in_progress: "amber",
  completed: "sage",
  failed: "oxide",
};

export function toolSignal(status: ToolStatus): SignalName {
  return TOOL_SIGNALS[status] ?? "slate";
}

/**
 * Context pressure. A window filling up is the single most useful number on
 * the board, and it earns a colour change rather than a percentage nobody
 * reads: sage while there is room, ochre once the end is in sight, oxide when
 * the next turn may not fit.
 */
export function pressureSignal(fraction: number): SignalName {
  if (!Number.isFinite(fraction) || fraction <= 0) return "slate";
  if (fraction >= 0.9) return "oxide";
  if (fraction >= 0.7) return "ochre";
  return "sage";
}
