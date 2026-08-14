/**
 * How numbers and paths are written on the board.
 *
 * Ported verbatim from the PWA's `ui/dom.ts`, minus the DOM helpers that shared
 * the file with them. These four are pure string work and already ran anywhere;
 * they are here rather than imported so the app package does not depend on a
 * package that is being retired.
 */

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
    // Hermes ships without full ICU on some builds, and a missing currency
    // table must degrade to a readable number rather than to a crash.
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
