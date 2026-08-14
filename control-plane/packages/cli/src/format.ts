/**
 * Terminal output shaping.
 *
 * A control plane's CLI is read at three in the morning by someone who wants
 * one fact. Columns line up, times are relative, and nothing is decorated.
 */

/** Column-align rows under headers. Empty input prints nothing at all. */
export function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];

  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? "").length), header.length),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();

  return [line(headers), ...rows.map(line)];
}

/** `2d 3h`, `4m 12s`, `900ms`. Two units is as much as anyone reads. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;

  const seconds = Math.floor(ms / 1000);
  const parts: Array<[number, string]> = [
    [Math.floor(seconds / 86_400), "d"],
    [Math.floor((seconds % 86_400) / 3600), "h"],
    [Math.floor((seconds % 3600) / 60), "m"],
    [seconds % 60, "s"],
  ];

  const significant = parts.filter(([value]) => value > 0).slice(0, 2);
  if (significant.length === 0) return "0s";
  return significant.map(([value, unit]) => `${value}${unit}`).join(" ");
}

/** An ISO timestamp as an age, which is what an operator is actually asking. */
export function age(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined || iso.length === 0) return "-";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return `${duration(now - at)} ago`;
}
