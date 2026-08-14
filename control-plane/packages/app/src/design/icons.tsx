/**
 * The icon vocabulary, drawn as real vectors.
 *
 * Every glyph is a Font Awesome path rendered through `react-native-svg`, which
 * is the only way to get one shape on five platforms: a webfont does not exist
 * on a phone, and an emoji is a picture of a concept rather than an icon of
 * one. Nothing in this app ever renders a character where an icon belongs.
 *
 * The console this ports from uses the Pro families: duotone for tool kinds, so
 * the kind's signal colour rides in the primary layer, and sharp for the two
 * decisions. Duotone, sharp, and thin are Pro-only, and this build has no Pro
 * registry token, so every entry below is the free solid family. The mapping is
 * one-for-one in meaning and the pairing is named in each comment where the Pro
 * glyph has no free twin.
 *
 * Icons are decorative here without exception. Anything an operator has to be
 * able to name carries a text label beside it, so the glyph is hidden from
 * assistive technology rather than given a label of its own.
 */

import { FontAwesomeIcon } from "@fortawesome/react-native-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRightToBracket,
  faBoxArchive,
  faBrain,
  faBuilding,
  faCheck,
  faChevronDown,
  faChevronLeft,
  faCircleNodes,
  faCircleQuestion,
  faCircleStop,
  faClockRotateLeft,
  faCoins,
  faDiagramProject,
  faFileLines,
  faFolder,
  faGaugeHigh,
  faGlobe,
  faHand,
  faLayerGroup,
  faListCheck,
  faMagnifyingGlass,
  faPaperPlane,
  faPen,
  faPlay,
  faPlug,
  faPlugCircleXmark,
  faPlus,
  faPuzzlePiece,
  faSignal,
  faSlash,
  faStore,
  faTerminal,
  faTrashCan,
  faTriangleExclamation,
  faWandMagicSparkles,
  faWindowMaximize,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { JSX } from "react";
import { ink } from "./tokens.ts";

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
  | "archive"
  | "restore"
  | "resume"
  | "attach"
  | "folder"
  | "tasks"
  | "newTask"
  | "skill"
  | "connector"
  | "plugin"
  | "native"
  | "marketplace"
  | "warning"
  | "browser"
  | "unknown";

export const GLYPHS: Record<GlyphName, IconDefinition> = {
  // `fa-brain-circuit` is Pro; the free brain carries the same meaning.
  think: faBrain,
  read: faFileLines,
  // Pro draws `fa-square-terminal`; free has the bare prompt.
  execute: faTerminal,
  search: faMagnifyingGlass,
  // Pro's `fa-pen-line` is a pen over its rule. Free is the pen alone.
  edit: faPen,
  fetch: faGlobe,
  move: faDiagramProject,
  delete: faTrashCan,
  other: faCircleNodes,
  // Pro's `fa-paper-plane-top` is the upright send; free's is the classic tilt.
  send: faPaperPlane,
  // Pro uses `fa-octagon-xmark`, the stop sign. Free's stop is a filled circle.
  interrupt: faCircleStop,
  allow: faCheck,
  deny: faXmark,
  back: faChevronLeft,
  unpair: faPlugCircleXmark,
  clearance: faHand,
  plan: faListCheck,
  load: faGaugeHigh,
  cost: faCoins,
  activity: faDiagramProject,
  // Pro's `fa-slash-forward` is the literal command prefix; free's slash reads
  // the same at this size.
  commands: faSlash,
  chevron: faChevronDown,
  // Pro's `fa-signal-bars` is the link strength meter; free's signal is it.
  link: faSignal,
  bay: faLayerGroup,
  archive: faBoxArchive,
  restore: faClockRotateLeft,
  // A dormant session is picked back up; play is the universal resume glyph.
  resume: faPlay,
  // A live-tui session is joined rather than resumed; a sign-in arrow reads as
  // stepping into something already running, distinct from starting it.
  attach: faArrowRightToBracket,
  folder: faFolder,
  // A checklist doubles for "the fleet's work plan" and "the task sidebar":
  // both are a list of items with a state, and share the glyph on purpose.
  tasks: faListCheck,
  newTask: faPlus,
  // Pro's `fa-wand-sparkles` variant differs only in spacing; free's is the
  // same shape and is what a skill invocation actually is: casting a workflow.
  skill: faWandMagicSparkles,
  connector: faPlug,
  plugin: faPuzzlePiece,
  // First-party: OMP itself is the org that built this. A building reads as
  // "the org's own", distinct from a store for anything installed from one.
  native: faBuilding,
  marketplace: faStore,
  warning: faTriangleExclamation,
  // The agent's own sandboxed WebView, which is a window it drives rather
  // than the globe `fetch` uses for an HTTP call with no page behind it.
  browser: faWindowMaximize,
  unknown: faCircleQuestion,
};

export interface GlyphProps {
  name: GlyphName;
  size?: number;
  color?: string;
}

export function Glyph({ name, size = 14, color = ink.plain }: GlyphProps): JSX.Element {
  return <FontAwesomeIcon icon={GLYPHS[name]} size={size} color={color} />;
}

/** Tool kinds and glyphs share a vocabulary, so the lookup is total by name. */
export const TOOL_GLYPHS: Record<string, GlyphName> = {
  think: "think",
  read: "read",
  execute: "execute",
  search: "search",
  edit: "edit",
  fetch: "fetch",
  move: "move",
  delete: "delete",
  other: "other",
};
