/**
 * The session browser's data model.
 *
 * Rows are sessions, not just live agents. A session this device has never
 * touched is still a first-class row. The four-value status vocabulary
 * (`live-tui`, `live-ompd`, `dormant`, `archived`) is the contract the daemon
 * index produces; this module consumes it and never invents its own.
 *
 * Grouping by directory is the primary organiser: 93 groups over 305 sessions
 * is unusable flat. Groups collapse, and a collapsed group shows a count and
 * the most severe status, so it still tells you something. Sorting applies
 * within groups and with grouping off. The active sort is always visible.
 *
 * All functions are pure. The test suite drives them with a realistic corpus
 * rather than three rows.
 */

// ---------------------------------------------------------------------------
// Status vocabulary (from the contract)
// ---------------------------------------------------------------------------

export type SessionStatus = "live-tui" | "live-ompd" | "dormant" | "archived";

/**
 * Severity rank, lowest number is most severe. Used for collapsed-group badges
 * and for the status sort. `live-tui` ranks highest because it means a human
 * is holding the session right now and it is the most actionable state.
 */
const STATUS_SEVERITY: Record<SessionStatus, number> = {
  "live-tui": 0,
  "live-ompd": 1,
  dormant: 2,
  archived: 3,
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * One session as the browser sees it. The daemon index populates this; the
 * browser never reads the filesystem.
 */
export interface BrowserSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  /** ISO 8601. When the session was created. */
  readonly createdAt: string;
  /** ISO 8601. Last activity timestamp. */
  readonly lastActiveAt: string;
  /** Number of messages in the transcript. */
  readonly messageCount: number;
  /** Bytes on disk. */
  readonly sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export type SortField = "status" | "age" | "lastActive" | "messageCount" | "size";
export type SortDirection = "asc" | "desc";

export interface SortSpec {
  readonly field: SortField;
  readonly direction: SortDirection;
}

/** Human-readable label for the active sort, so the list order has a name. */
export const SORT_LABELS: Record<SortField, string> = {
  status: "Status",
  age: "Age",
  lastActive: "Last active",
  messageCount: "Messages",
  size: "Size",
};

function compareSessions(a: BrowserSession, b: BrowserSession, sort: SortSpec): number {
  let cmp = 0;
  switch (sort.field) {
    case "status":
      cmp = STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status];
      break;
    case "age":
      // Older first in ascending: earlier createdAt sorts first.
      cmp = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      break;
    case "lastActive":
      cmp = Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt);
      break;
    case "messageCount":
      cmp = a.messageCount - b.messageCount;
      break;
    case "size":
      cmp = a.sizeBytes - b.sizeBytes;
      break;
  }
  if (sort.direction === "desc") cmp = -cmp;
  // Stable tie-break: most recently active first, then id.
  if (cmp === 0) cmp = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
  if (cmp === 0) cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return cmp;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface SessionGroup {
  readonly cwd: string;
  readonly sessions: readonly BrowserSession[];
  /** The most severe status in the group. */
  readonly worstStatus: SessionStatus;
  /** Total session count (before archive filtering). */
  readonly totalCount: number;
}

/**
 * Groups sessions by cwd. Each group's sessions are sorted by the active sort.
 * Groups themselves are ordered by the worst status in the group (most severe
 * first), then by recency of the most recent session.
 */
export function groupByCwd(
  sessions: readonly BrowserSession[],
  sort: SortSpec,
): SessionGroup[] {
  const byDir = new Map<string, BrowserSession[]>();
  for (const session of sessions) {
    let bucket = byDir.get(session.cwd);
    if (!bucket) {
      bucket = [];
      byDir.set(session.cwd, bucket);
    }
    bucket.push(session);
  }

  const groups: SessionGroup[] = [];
  for (const [cwd, bucket] of byDir) {
    const sorted = [...bucket].sort((a, b) => compareSessions(a, b, sort));
    groups.push({
      cwd,
      sessions: sorted,
      worstStatus: worstStatusOf(sorted),
      totalCount: sorted.length,
    });
  }

  // Sort groups: most severe status first, then most recently active.
  groups.sort((a, b) => {
    const sev = STATUS_SEVERITY[a.worstStatus] - STATUS_SEVERITY[b.worstStatus];
    if (sev !== 0) return sev;
    const aRecent = Math.max(...a.sessions.map((s) => Date.parse(s.lastActiveAt)));
    const bRecent = Math.max(...b.sessions.map((s) => Date.parse(s.lastActiveAt)));
    return bRecent - aRecent;
  });

  return groups;
}

function worstStatusOf(sessions: readonly BrowserSession[]): SessionStatus {
  let worst: SessionStatus = "archived";
  for (const s of sessions) {
    if (STATUS_SEVERITY[s.status] < STATUS_SEVERITY[worst]) {
      worst = s.status;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Browser state (the reducer)
// ---------------------------------------------------------------------------

export interface BrowserState {
  readonly sessions: readonly BrowserSession[];
  readonly sort: SortSpec;
  readonly showArchived: boolean;
  readonly collapsedGroups: ReadonlySet<string>;
  /** Grouping is the default organiser; a person can flatten the list. */
  readonly grouped: boolean;
}

export const DEFAULT_SORT: SortSpec = { field: "status", direction: "asc" };

export const EMPTY_BROWSER: BrowserState = {
  sessions: [],
  sort: DEFAULT_SORT,
  showArchived: false,
  collapsedGroups: new Set(),
  grouped: true,
};

export type BrowserAction =
  | { t: "load"; sessions: readonly BrowserSession[] }
  | { t: "sort"; field: SortField }
  | { t: "toggleArchived" }
  | { t: "toggleGroup"; cwd: string }
  | { t: "toggleGrouped" }
  | { t: "archive"; id: string }
  | { t: "unarchive"; id: string };

export function browserReduce(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.t) {
    case "load":
      return { ...state, sessions: action.sessions };

    case "sort": {
      if (state.sort.field === action.field) {
        // Toggle direction.
        return {
          ...state,
          sort: {
            field: action.field,
            direction: state.sort.direction === "asc" ? "desc" : "asc",
          },
        };
      }
      // Status defaults ascending (most severe first); everything else defaults
      // descending (newest/largest/most first).
      return {
        ...state,
        sort: {
          field: action.field,
          direction: action.field === "status" ? "asc" : "desc",
        },
      };
    }

    case "toggleArchived":
      return { ...state, showArchived: !state.showArchived };

    case "toggleGrouped":
      return { ...state, grouped: !state.grouped };

    case "toggleGroup": {
      const next = new Set(state.collapsedGroups);
      if (next.has(action.cwd)) {
        next.delete(action.cwd);
      } else {
        next.add(action.cwd);
      }
      return { ...state, collapsedGroups: next };
    }

    case "archive":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, status: "archived" as const } : s,
        ),
      };

    case "unarchive":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, status: "dormant" as const } : s,
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Derived view
// ---------------------------------------------------------------------------

/** What the UI actually renders. Computed from state, never stored. */
export interface BrowserView {
  readonly groups: readonly SessionGroup[];
  /** The same visible sessions, sorted flat, for when grouping is off. */
  readonly flatSessions: readonly BrowserSession[];
  /** Total visible sessions (excluding archived unless shown). */
  readonly visibleCount: number;
  /** Total session count including archived. */
  readonly totalCount: number;
  /** Number of archived sessions hidden. */
  readonly hiddenArchived: number;
}

export function browserView(state: BrowserState): BrowserView {
  const { sessions, sort, showArchived } = state;
  const visible = showArchived
    ? sessions
    : sessions.filter((s) => s.status !== "archived");
  const groups = groupByCwd(visible, sort);
  const flatSessions = [...visible].sort((a, b) => compareSessions(a, b, sort));
  const hiddenArchived = showArchived
    ? 0
    : sessions.filter((s) => s.status === "archived").length;

  return {
    groups,
    flatSessions,
    visibleCount: visible.length,
    totalCount: sessions.length,
    hiddenArchived,
  };
}

// ---------------------------------------------------------------------------
// Status signal mapping
// ---------------------------------------------------------------------------

export type SignalName = "amber" | "sage" | "ochre" | "oxide" | "slate" | "violet";

export const SESSION_STATUS_SIGNALS: Record<SessionStatus, SignalName> = {
  "live-tui": "amber",
  "live-ompd": "sage",
  dormant: "slate",
  archived: "slate",
};

/** Human-readable status label. */
export const STATUS_LABELS: Record<SessionStatus, string> = {
  "live-tui": "Live (TUI)",
  "live-ompd": "Live (agent)",
  dormant: "Dormant",
  archived: "Archived",
};

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "--";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
