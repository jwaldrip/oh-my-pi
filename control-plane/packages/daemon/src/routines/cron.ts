/**
 * Cron expression evaluation against a named IANA timezone.
 *
 * Standard five fields: `minute hour day-of-month month day-of-week`, each
 * accepting `*`, `a`, `a-b`, `a,b,c`, and a `/n` step on any of those.
 *
 * The whole search runs in *wall clock* space rather than on instants. A wall
 * clock reading is encoded as the epoch ms of its calendar fields read as if
 * they were UTC, which makes "add a minute" and "roll to the next month" exact
 * calendar arithmetic with no offset to trip over. The timezone offset is
 * applied exactly once, at the end, where the two genuinely ambiguous cases
 * live and are decided deliberately. See `instantFromWall`.
 *
 * No dependency: the offset comes from `Intl.DateTimeFormat`, which is the only
 * IANA timezone database the runtime already carries.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** How far ahead a search looks before calling an expression unsatisfiable. */
const MAX_SEARCH_YEARS = 10;

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

interface FieldRange {
  min: number;
  max: number;
}

/** Static table, so a Record. `dayOfWeek` accepts 7 as a second spelling of Sunday. */
const FIELD_RANGES: Record<CronFieldName, FieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

const FIELD_ORDER: readonly CronFieldName[] = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
];

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /**
   * Vixie's rule, and the one thing about cron that surprises everybody: when
   * BOTH day fields are restricted the match is their union, not the
   * intersection. `0 0 13 * 5` is "the 13th, and also every Friday".
   */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

function parseField(name: CronFieldName, text: string): Set<number> {
  const { min, max } = FIELD_RANGES[name];
  const values = new Set<number>();

  const readInt = (raw: string): number => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n)) {
      throw new CronError(`${name}: "${raw}" is not an integer`);
    }
    return n;
  };

  for (const term of text.split(",")) {
    const piece = term.trim();
    if (piece === "") throw new CronError(`${name}: empty term in "${text}"`);

    const slash = piece.indexOf("/");
    const rangeText = slash === -1 ? piece : piece.slice(0, slash);
    let step = 1;
    if (slash !== -1) {
      step = readInt(piece.slice(slash + 1));
      if (step < 1) throw new CronError(`${name}: step must be at least 1, got ${step}`);
    }

    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = min;
      hi = max;
    } else {
      const dash = rangeText.indexOf("-");
      if (dash === -1) {
        lo = readInt(rangeText);
        // `5/15` is Vixie shorthand for "5 through the top of the range, by 15".
        hi = slash === -1 ? lo : max;
      } else {
        lo = readInt(rangeText.slice(0, dash));
        hi = readInt(rangeText.slice(dash + 1));
      }
    }

    if (lo < min || hi > max) {
      throw new CronError(`${name}: ${lo}-${hi} is outside ${min}-${max}`);
    }
    if (lo > hi) throw new CronError(`${name}: range ${lo}-${hi} runs backwards`);

    // Stepping from `lo` is what makes `*/7` stop at 56 rather than wrapping to
    // 63: the period does not have to divide the range.
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return values;
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    throw new CronError(`expected 5 fields, got ${expression.trim() === "" ? 0 : fields.length}: "${expression}"`);
  }

  const parsed = {} as Record<CronFieldName, Set<number>>;
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    const name = FIELD_ORDER[i] as CronFieldName;
    parsed[name] = parseField(name, fields[i] as string);
  }

  const dayOfWeek = parsed.dayOfWeek;
  if (dayOfWeek.has(7)) {
    dayOfWeek.add(0);
    dayOfWeek.delete(7);
  }

  return {
    ...parsed,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

/** Runtime cache, so a Map. Building a DateTimeFormat is not cheap. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // h23 rather than hour12:false, which yields "24" on some engines.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new CronError(`unknown timezone "${timezone}"`);
  }

  FORMATTERS.set(timezone, formatter);
  return formatter;
}

/**
 * The wall clock in `timezone` at `instantMs`, encoded as the epoch ms of those
 * same calendar fields read as UTC.
 */
function wallClockMs(instantMs: number, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(new Date(instantMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "second") second = Number(part.value);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Every absolute instant that renders as this wall clock reading, ascending.
 *
 * Usually one. The two interesting cases:
 *
 * - **Ambiguous** (the hour a fall-back repeats) yields two, earliest first.
 *   Callers take the earliest still in range, so a nightly job fires once
 *   rather than twice, and a caller already past the first occurrence can
 *   still reach the second.
 * - **Nonexistent** (the hour a spring-forward skips) yields the single
 *   instant the clock jumps, so a nightly job does not silently lose a day.
 */
function instantsFromWall(wallMs: number, timezone: string): number[] {
  // Probe a four day window. Any offset in force near the target appears here,
  // and no zone changes offset twice inside four days.
  const offsets = new Set<number>();
  for (let step = -2; step <= 2; step++) {
    const probe = wallMs + step * DAY_MS;
    offsets.add(wallClockMs(probe, timezone) - probe);
  }

  const found: number[] = [];
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (wallClockMs(candidate, timezone) !== wallMs) continue;
    found.push(candidate);
  }
  if (found.length > 0) return found.sort((a, b) => a - b);

  // No offset renders this reading, so the clock jumped over it. Bisect for the
  // instant the offset changes and fire there. The offset is piecewise constant
  // with exactly one change in this window, so the bisection is sound.
  //
  // On whole seconds, though: `wallClockMs` resolves to the second, so a probe
  // carrying milliseconds reports an offset short by exactly that remainder.
  // That fake drift makes every such probe compare unequal and walks the search
  // to an arbitrary instant. Zone transitions land on a whole minute regardless.
  let lo = Math.floor((wallMs - 2 * DAY_MS) / 1000);
  let hi = Math.floor((wallMs + 2 * DAY_MS) / 1000);
  const before = wallClockMs(lo * 1000, timezone) - lo * 1000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (wallClockMs(mid * 1000, timezone) - mid * 1000 === before) lo = mid;
    else hi = mid;
  }
  return [hi * 1000];
}

/**
 * The first instant strictly after `after` at which `expression` fires.
 *
 * `timezone` defaults to the host zone. Seconds are always zero: cron has a
 * one minute resolution, so a fire time landing mid-minute would be a bug.
 */
export function nextFireTime(expression: string, after: Date, timezone?: string): Date {
  const schedule = parseCron(expression);
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const startMs = after.getTime();
  if (!Number.isFinite(startMs)) throw new CronError("`after` is not a valid date");

  // Truncate to the minute and step past it, so the result is strictly after.
  let wall = Math.floor(wallClockMs(startMs, zone) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const deadlineYear = new Date(wall).getUTCFullYear() + MAX_SEARCH_YEARS;

  // One cursor reused across the walk rather than a Date per candidate.
  const cursor = new Date(wall);
  for (;;) {
    cursor.setTime(wall);
    const year = cursor.getUTCFullYear();
    if (year > deadlineYear) {
      throw new CronError(
        `"${expression}" has no fire time within ${MAX_SEARCH_YEARS} years of ${after.toISOString()}`,
      );
    }

    const month = cursor.getUTCMonth() + 1;
    if (!schedule.month.has(month)) {
      // `month` is 1-based here, so it is already the 0-based index of the next
      // one. Date.UTC rolls December into January of the following year.
      wall = Date.UTC(year, month, 1, 0, 0, 0);
      continue;
    }

    const day = cursor.getUTCDate();
    const dayOfMonthOk = schedule.dayOfMonth.has(day);
    const dayOfWeekOk = schedule.dayOfWeek.has(cursor.getUTCDay());
    const dayOk =
      schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
        ? dayOfMonthOk || dayOfWeekOk
        : dayOfMonthOk && dayOfWeekOk;
    if (!dayOk) {
      // Overflowing the day is how a 29 February search skips a common year:
      // Date.UTC normalises 29 February 2027 to 1 March, and the month test
      // above then jumps to the next February.
      wall = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!schedule.hour.has(hour)) {
      wall = Date.UTC(year, month - 1, day, hour + 1, 0, 0);
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!schedule.minute.has(minute)) {
      wall = Date.UTC(year, month - 1, day, hour, minute + 1, 0);
      continue;
    }

    // A matching reading is not automatically a future instant. Inside a
    // repeated fall-back hour the earlier occurrence can already be behind
    // `after`, and returning it would hand the scheduler a due time in the
    // past to fire on forever. Take the earliest occurrence that is genuinely
    // ahead, and step the reading on when there is none.
    const occurrences = instantsFromWall(wall, zone);
    for (const occurrence of occurrences) {
      if (occurrence > startMs) return new Date(occurrence);
    }
    wall += MINUTE_MS;
  }
}
