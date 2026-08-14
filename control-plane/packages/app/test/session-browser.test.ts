/**
 * The session browser's data model, driven with a realistic corpus.
 *
 * 12 directories, several sessions each, a deliberate mix of every status and
 * every sort dimension out of alignment with the others, so a test that
 * passes by coincidence (sorted by age happens to also be sorted by size)
 * cannot happen here.
 */

import { describe, expect, test } from "bun:test";
import {
  browserReduce,
  browserView,
  DEFAULT_SORT,
  EMPTY_BROWSER,
  groupByCwd,
  SORT_LABELS,
} from "../src/session/browser.ts";
import type { BrowserSession, BrowserState, SessionStatus, SortField } from "../src/session/browser.ts";
import { makeSession as session, makeSessionCorpus } from "./fixtures/session-corpus.ts";

const CORPUS = makeSessionCorpus(12);

describe("grouping by cwd", () => {
  test("every session lands in exactly one group, and every group is a real cwd", () => {
    const groups = groupByCwd(CORPUS, DEFAULT_SORT);
    const total = groups.reduce((sum, g) => sum + g.sessions.length, 0);
    expect(total).toBe(CORPUS.length);
    const cwds = new Set(CORPUS.map((s) => s.cwd));
    expect(groups.length).toBe(cwds.size);
    for (const group of groups) {
      expect(group.sessions.every((s) => s.cwd === group.cwd)).toBe(true);
    }
  });

  test("a group's totalCount matches its session count", () => {
    const groups = groupByCwd(CORPUS, DEFAULT_SORT);
    for (const group of groups) expect(group.totalCount).toBe(group.sessions.length);
  });

  test("groups order by worst status first, most severe group leading", () => {
    const groups = groupByCwd(CORPUS, DEFAULT_SORT);
    const severities = groups.map((g) => g.worstStatus);
    const rank: Record<SessionStatus, number> = { "live-tui": 0, "live-ompd": 1, dormant: 2, archived: 3 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i - 1] as SessionStatus]).toBeLessThanOrEqual(rank[severities[i] as SessionStatus]);
    }
    // At least one group actually is live-tui in this corpus (every 4th row).
    expect(groups[0]?.worstStatus).toBe("live-tui");
  });

  test("a directory that appears once still gets its own group", () => {
    const lonely = [session({ cwd: "/Users/op/one-off" })];
    const groups = groupByCwd(lonely, DEFAULT_SORT);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.cwd).toBe("/Users/op/one-off");
    expect(groups[0]?.totalCount).toBe(1);
  });
});

describe("status precedence in a collapsed group", () => {
  test("the worst status is the most severe member, regardless of position", () => {
    const dir = "/Users/op/mixed";
    const rows = [
      session({ cwd: dir, status: "dormant" }),
      session({ cwd: dir, status: "archived" }),
      session({ cwd: dir, status: "live-tui" }),
      session({ cwd: dir, status: "live-ompd" }),
    ];
    const [group] = groupByCwd(rows, DEFAULT_SORT);
    expect(group?.worstStatus).toBe("live-tui");
  });

  test("a group of only dormant and archived sessions reports dormant as worst", () => {
    const dir = "/Users/op/quiet";
    const rows = [
      session({ cwd: dir, status: "archived" }),
      session({ cwd: dir, status: "archived" }),
      session({ cwd: dir, status: "dormant" }),
    ];
    const [group] = groupByCwd(rows, DEFAULT_SORT);
    expect(group?.worstStatus).toBe("dormant");
  });

  test("a group of only archived sessions reports archived as worst", () => {
    const dir = "/Users/op/all-archived";
    const rows = [session({ cwd: dir, status: "archived" }), session({ cwd: dir, status: "archived" })];
    const [group] = groupByCwd(rows, DEFAULT_SORT);
    expect(group?.worstStatus).toBe("archived");
  });

  test("collapsing a group does not change what its header would report", () => {
    // The header's badge is computed from the group's sessions, independent of
    // whether a caller chooses to render them. Collapsing is a rendering
    // decision layered on top by BrowserState.collapsedGroups, not a change to
    // the group's own data.
    const dir = "/Users/op/collapsible";
    const rows = [session({ cwd: dir, status: "dormant" }), session({ cwd: dir, status: "live-tui" })];
    const [group] = groupByCwd(rows, DEFAULT_SORT);
    expect(group?.worstStatus).toBe("live-tui");
    expect(group?.totalCount).toBe(2);

    let state: BrowserState = { ...EMPTY_BROWSER, sessions: rows };
    state = browserReduce(state, { t: "toggleGroup", cwd: dir });
    const collapsedGroup = browserView(state).groups.find((g) => g.cwd === dir);
    // The group is still present, still full, and still reports the same
    // worst status; only whether a UI chooses to render its rows changed.
    expect(collapsedGroup?.worstStatus).toBe("live-tui");
    expect(collapsedGroup?.totalCount).toBe(2);
    expect(collapsedGroup?.sessions).toHaveLength(2);
  });
});

describe("every sort order", () => {
  const fields: SortField[] = ["status", "age", "lastActive", "messageCount", "size"];

  for (const field of fields) {
    test(`${field} ascending is monotonic across the whole corpus`, () => {
      const groups = groupByCwd(CORPUS, { field, direction: "asc" });
      const flat = groups.flatMap((g) => g.sessions);
      // Grouped output re-partitions by cwd; verify monotonicity within each
      // group, which is what the field claims to guarantee.
      for (const group of groups) {
        const values = group.sessions.map((s) => sortKey(s, field));
        for (let i = 1; i < values.length; i++) {
          expect(values[i - 1]).toBeLessThanOrEqual(values[i] as number);
        }
      }
      expect(flat.length).toBe(CORPUS.length);
    });

    test(`${field} descending is monotonically non-increasing across the whole corpus`, () => {
      // Not a literal reverse of ascending: fields with repeated values (status
      // has only four) tie-break on recency regardless of direction, so a
      // direct reversal comparison would assert an ordering the reducer never
      // promised. Monotonicity in both directions is what it does promise.
      const groups = groupByCwd(CORPUS, { field, direction: "desc" });
      for (const group of groups) {
        const values = group.sessions.map((s) => sortKey(s, field));
        for (let i = 1; i < values.length; i++) {
          expect(values[i - 1]).toBeGreaterThanOrEqual(values[i] as number);
        }
      }
    });
  }

  test("a tap on the active sort chip flips direction, not field", () => {
    let state: BrowserState = { ...EMPTY_BROWSER, sort: { field: "size", direction: "asc" } };
    state = browserReduce(state, { t: "sort", field: "size" });
    expect(state.sort).toEqual({ field: "size", direction: "desc" });
    state = browserReduce(state, { t: "sort", field: "size" });
    expect(state.sort).toEqual({ field: "size", direction: "asc" });
  });

  test("switching to a new field resets direction to that field's default", () => {
    let state: BrowserState = { ...EMPTY_BROWSER, sort: { field: "status", direction: "asc" } };
    state = browserReduce(state, { t: "sort", field: "messageCount" });
    // Everything but status defaults to descending: newest/largest/most first.
    expect(state.sort).toEqual({ field: "messageCount", direction: "desc" });
    state = browserReduce(state, { t: "sort", field: "status" });
    expect(state.sort).toEqual({ field: "status", direction: "asc" });
  });

  test("every SortField has a nonempty human label, so the active sort is always nameable", () => {
    for (const field of fields) {
      expect(SORT_LABELS[field].length).toBeGreaterThan(0);
    }
  });

  test("sorting with grouping off flattens the whole corpus in one order", () => {
    const state: BrowserState = {
      ...EMPTY_BROWSER,
      sessions: CORPUS,
      sort: { field: "size", direction: "desc" },
      grouped: false,
      showArchived: true,
    };
    const view = browserView(state);
    expect(view.flatSessions.length).toBe(CORPUS.length);
    for (let i = 1; i < view.flatSessions.length; i++) {
      const a = view.flatSessions[i - 1] as BrowserSession;
      const b = view.flatSessions[i] as BrowserSession;
      expect(a.sizeBytes).toBeGreaterThanOrEqual(b.sizeBytes);
    }
  });
});

describe("archived sessions", () => {
  function withArchived(): BrowserState {
    return { ...EMPTY_BROWSER, sessions: CORPUS };
  }

  test("hidden by default", () => {
    const view = browserView(withArchived());
    const archivedCount = CORPUS.filter((s) => s.status === "archived").length;
    expect(archivedCount).toBeGreaterThan(0);
    expect(view.hiddenArchived).toBe(archivedCount);
    expect(view.visibleCount).toBe(CORPUS.length - archivedCount);
    for (const group of view.groups) {
      expect(group.sessions.every((s) => s.status !== "archived")).toBe(true);
    }
  });

  test("shown on request", () => {
    let state = withArchived();
    state = browserReduce(state, { t: "toggleArchived" });
    expect(state.showArchived).toBe(true);
    const view = browserView(state);
    expect(view.hiddenArchived).toBe(0);
    expect(view.visibleCount).toBe(CORPUS.length);
    const archivedSeen = view.groups.some((g) => g.sessions.some((s) => s.status === "archived"));
    expect(archivedSeen).toBe(true);
  });

  test("toggling twice returns to hidden", () => {
    let state = withArchived();
    state = browserReduce(state, { t: "toggleArchived" });
    state = browserReduce(state, { t: "toggleArchived" });
    expect(state.showArchived).toBe(false);
    expect(browserView(state).hiddenArchived).toBeGreaterThan(0);
  });

  test("archiving a session removes it from the default view without deleting it", () => {
    const target = CORPUS.find((s) => s.status === "dormant") as BrowserSession;
    let state: BrowserState = { ...EMPTY_BROWSER, sessions: CORPUS };
    state = browserReduce(state, { t: "archive", id: target.id });
    expect(state.sessions.find((s) => s.id === target.id)?.status).toBe("archived");
    expect(state.sessions).toHaveLength(CORPUS.length);
    const view = browserView(state);
    expect(view.groups.some((g) => g.sessions.some((s) => s.id === target.id))).toBe(false);
  });

  test("unarchiving returns a session to dormant and back into the default view", () => {
    const target = CORPUS.find((s) => s.status === "archived") as BrowserSession;
    let state: BrowserState = { ...EMPTY_BROWSER, sessions: CORPUS };
    state = browserReduce(state, { t: "unarchive", id: target.id });
    expect(state.sessions.find((s) => s.id === target.id)?.status).toBe("dormant");
    const view = browserView(state);
    expect(view.groups.some((g) => g.sessions.some((s) => s.id === target.id))).toBe(true);
  });
});

describe("grouping toggle and group collapse", () => {
  test("toggleGrouped flips the grouped flag", () => {
    let state = EMPTY_BROWSER;
    expect(state.grouped).toBe(true);
    state = browserReduce(state, { t: "toggleGrouped" });
    expect(state.grouped).toBe(false);
    state = browserReduce(state, { t: "toggleGrouped" });
    expect(state.grouped).toBe(true);
  });

  test("toggleGroup collapses and re-expands a single group by cwd", () => {
    let state = EMPTY_BROWSER;
    state = browserReduce(state, { t: "toggleGroup", cwd: "/a" });
    expect(state.collapsedGroups.has("/a")).toBe(true);
    state = browserReduce(state, { t: "toggleGroup", cwd: "/b" });
    expect(state.collapsedGroups.has("/a")).toBe(true);
    expect(state.collapsedGroups.has("/b")).toBe(true);
    state = browserReduce(state, { t: "toggleGroup", cwd: "/a" });
    expect(state.collapsedGroups.has("/a")).toBe(false);
    expect(state.collapsedGroups.has("/b")).toBe(true);
  });

  test("the reducer never mutates the state it was handed", () => {
    const before = EMPTY_BROWSER;
    const beforeCollapsed = before.collapsedGroups;
    browserReduce(before, { t: "toggleGroup", cwd: "/a" });
    expect(before.collapsedGroups).toBe(beforeCollapsed);
    expect(before.collapsedGroups.has("/a")).toBe(false);
  });
});

/** Numeric projection of a session along a sort field, for monotonicity checks. */
function sortKey(session: BrowserSession, field: SortField): number {
  switch (field) {
    case "status":
      return { "live-tui": 0, "live-ompd": 1, dormant: 2, archived: 3 }[session.status];
    case "age":
      return Date.parse(session.createdAt);
    case "lastActive":
      return Date.parse(session.lastActiveAt);
    case "messageCount":
      return session.messageCount;
    case "size":
      return session.sizeBytes;
  }
}
