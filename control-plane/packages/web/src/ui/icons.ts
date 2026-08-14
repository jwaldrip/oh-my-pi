/**
 * Icons come from the Font Awesome Pro kit loaded in `index.html`. Nothing here
 * draws paths: the kit replaces each `<i>` with an `<svg>` on insert.
 *
 * Tool kinds use duotone, because a two-layer glyph can carry the kind's signal
 * colour in its primary layer and stay legible at 14px in a dense log. The
 * colours themselves come from CSS, keyed off `data-kind`, so the palette lives
 * in one file.
 *
 * A subsetted kit renders a dashed placeholder rather than failing loudly, so
 * this table is checked rather than trusted: `scripts/verify-icons.ts` draws
 * every entry in a headless Chrome and fails on any that carries no path data.
 * The console itself can be audited the same way, by counting
 * `svg.svg-inline--fa` against leftover `i.gl` on a rendered page.
 */

export type GlyphName =
  | "think"
  | "read"
  | "execute"
  | "search"
  | "edit"
  | "fetch"
  | "move"
  | "delete"
  | "other"
  | "send"
  | "interrupt"
  | "allow"
  | "deny"
  | "back"
  | "unpair"
  | "clearance"
  | "plan"
  | "load"
  | "cost"
  | "activity"
  | "commands"
  | "chevron"
  | "link"
  | "bay"
  | "unknown";

export const GLYPHS: Record<GlyphName, string> = {
  think: "fa-duotone fa-solid fa-brain-circuit",
  read: "fa-duotone fa-solid fa-file-lines",
  execute: "fa-duotone fa-solid fa-square-terminal",
  search: "fa-duotone fa-solid fa-magnifying-glass",
  edit: "fa-duotone fa-solid fa-pen-line",
  fetch: "fa-duotone fa-solid fa-globe",
  move: "fa-duotone fa-solid fa-diagram-project",
  delete: "fa-duotone fa-solid fa-trash-can",
  other: "fa-duotone fa-solid fa-circle-nodes",
  send: "fa-solid fa-paper-plane-top",
  interrupt: "fa-solid fa-octagon-xmark",
  allow: "fa-sharp fa-solid fa-check",
  deny: "fa-sharp fa-solid fa-xmark",
  back: "fa-sharp fa-solid fa-chevron-left",
  unpair: "fa-solid fa-plug-circle-xmark",
  clearance: "fa-duotone fa-solid fa-hand",
  plan: "fa-duotone fa-solid fa-list-check",
  load: "fa-duotone fa-solid fa-gauge-high",
  cost: "fa-duotone fa-solid fa-coins",
  activity: "fa-duotone fa-solid fa-diagram-project",
  commands: "fa-solid fa-slash-forward",
  chevron: "fa-sharp fa-solid fa-chevron-down",
  link: "fa-solid fa-signal-bars",
  bay: "fa-duotone fa-solid fa-layer-group",
  unknown: "fa-duotone fa-solid fa-circle-question",
};

/**
 * A decorative glyph. Anything an operator must be able to name gets a text
 * label beside it instead of a title attribute, so this is always hidden from
 * assistive technology.
 */
export function icon(name: GlyphName, extra = ""): HTMLElement {
  const node = document.createElement("i");
  node.className = extra.length > 0 ? `${GLYPHS[name]} gl ${extra}` : `${GLYPHS[name]} gl`;
  node.setAttribute("aria-hidden", "true");
  return node;
}
