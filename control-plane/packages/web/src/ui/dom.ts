/**
 * The small amount of DOM plumbing every view needs. No framework, so this is
 * the whole abstraction layer: build an element, patch text, format a stamp.
 */

export interface ElementSpec {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: (Node | null | undefined)[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (spec.class !== undefined) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, value);
  }
  if (spec.children) {
    for (const child of spec.children) {
      if (child) node.append(child);
    }
  }
  return node;
}

/** Writes `text` only when it changed, so patching never disturbs selection. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  node.textContent = text;
}

/** Adds or removes `name` to match `on`. */
export function toggleClass(node: HTMLElement, name: string, on: boolean): void {
  if (on) {
    node.classList.add(name);
    return;
  }
  node.classList.remove(name);
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

const UNITS: readonly { limit: number; seconds: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60, seconds: 1, unit: "second" },
  { limit: 3_600, seconds: 60, unit: "minute" },
  { limit: 86_400, seconds: 3_600, unit: "hour" },
  { limit: 604_800, seconds: 86_400, unit: "day" },
  { limit: 2_629_800, seconds: 604_800, unit: "week" },
  { limit: Number.POSITIVE_INFINITY, seconds: 2_629_800, unit: "month" },
];

/**
 * "12m ago" style stamp for an ISO timestamp. Operators scan this column, so
 * it stays short and never shows a raw date for anything recent.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const deltaSeconds = (then - now) / 1000;
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 5) return "now";
  for (const step of UNITS) {
    if (magnitude >= step.limit) continue;
    return RELATIVE.format(Math.round(deltaSeconds / step.seconds), step.unit);
  }
  return "unknown";
}

/**
 * Renders arbitrary wire data for human eyes. Tool inputs are whatever the
 * model produced, so this has to survive cycles, functions, and bare strings.
 */
export function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return entry;
        if (seen.has(entry)) return "[circular]";
        seen.add(entry);
        return entry;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

/**
 * A running clock, as a strip carries. Counts up from a stamp and stays
 * fixed-pitch so a column of them does not jitter as the seconds tick.
 */
export function elapsed(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "--:--";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${String(seconds).padStart(2, "0")}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Token counts, at the width a data block can spare. Context windows run to
 * seven figures, and the exact digit never matters as much as the magnitude.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * Real spend. Sub-cent turns are the normal case, so this keeps four decimals
 * rather than rounding a live meter down to $0.00 and looking broken.
 */
export function formatMoney(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return "--";
  const digits = amount < 10 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/**
 * Shortens a path from the left, which is where the uninteresting part is. A
 * strip's origin column is narrow and the last two segments are what identify
 * the work.
 */
export function shortenPath(path: string, segments = 2): string {
  const home = path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  const parts = home.split("/").filter((part) => part.length > 0);
  if (parts.length <= segments + (home.startsWith("~") ? 1 : 0)) return home;
  return `…/${parts.slice(-segments).join("/")}`;
}
