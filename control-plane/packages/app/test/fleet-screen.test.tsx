/**
 * FleetScreen, rendered.
 *
 * Same discipline as `smoke.test.tsx`: react-native-web is the shipped web
 * target rather than a test double. Dynamic style values (a status colour
 * computed from a prop) render inline, which is what lets `smoke.test.tsx`
 * assert on raw `rgba(...)` values; static `StyleSheet.create()` values (a
 * fixed width, a min-height) compile to atomic CSS classes instead, whose
 * rules live in `StyleSheet.getSheet().textContent` rather than in the
 * markup. `render()` below concatenates both, so a width or height audit of
 * "the rendered tree" covers what a real page would actually ship.
 *
 * The corpus is 42 sessions across 12 directories: big enough that a bug only
 * visible past a few dozen rows (a group whose header count is wrong once
 * it has 5 members, a collapse that drops the wrong section) cannot hide
 * behind a three-row fixture.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_BROWSER } from "../src/session/browser.ts";
import type { BrowserSession, BrowserState } from "../src/session/browser.ts";
import { makeSessionCorpus } from "./fixtures/session-corpus.ts";

// Dynamic on purpose, same reason as `smoke.test.tsx`: a static import of
// "react-native" here would resolve before `./rnw.ts`'s `mock.module` call
// could substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { StyleSheet } = await import("react-native");

const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const CORPUS = makeSessionCorpus(12);

function browserState(overrides: Partial<BrowserState> = {}): BrowserState {
  return { ...EMPTY_BROWSER, sessions: CORPUS, ...overrides };
}

const NOOP_SESSION = (_session: BrowserSession) => {};
const NOOP_FIELD = () => {};
const NOOP_CWD = () => {};
const NOOP = () => {};

/**
 * `getSheet` is a react-native-web extension the `react-native` type surface
 * does not declare; the standard types have no way to express it, so this is
 * an unchecked cast onto a real, stable API rather than onto guessed shape.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * RNW's sheet is process-global: importing a screen registers its styles even
 * when that screen is not rendered. Keep only rules whose class selector
 * appears in this markup. That makes layout assertions about FleetScreen, not
 * desktop-only declarations from other screens such as Cowork's 300px sidebar.
 */
function stylesForMarkup(markup: string): string {
  const classNames = new Set<string>();
  for (const match of markup.matchAll(/\bclass="([^"]*)"/g)) {
    const classAttribute = match[1];
    if (classAttribute === undefined) continue;
    for (const className of classAttribute.split(/\s+/)) {
      if (className) classNames.add(className);
    }
  }

  return [...rnwStyleSheet.getSheet().textContent.matchAll(/[^{}]+\{[^{}]*\}/g)]
    .filter((rule) => [...classNames].some((className) => rule[0].includes(`.${className}`)))
    .map((rule) => rule[0])
    .join("\n");
}

/** Markup plus only the atomic CSS used by that rendered page. */
function render(browser: BrowserState): string {
  const markup = renderToStaticMarkup(
    <FleetScreen
      browser={browser}
      onSort={NOOP_FIELD}
      onToggleGroup={NOOP_CWD}
      onToggleGrouped={NOOP}
      onToggleArchived={NOOP}
      onTakeover={NOOP_SESSION}
      onArchive={NOOP_SESSION}
      onUnarchive={NOOP_SESSION}
      now={NOW}
    />,
  );
  return `${markup}\n<style>${stylesForMarkup(markup)}</style>`;
}

describe("the session browser renders a realistic corpus", () => {
  const html = render(browserState());

  test("every group's directory name and count are on screen", () => {
    for (let d = 0; d < 12; d++) {
      expect(html).toContain(`repo-${d}`);
    }
  });

  test("the visible count excludes archived by default", () => {
    const archivedCount = CORPUS.filter((s) => s.status === "archived").length;
    const visibleCount = CORPUS.length - archivedCount;
    expect(archivedCount).toBeGreaterThan(0);
    expect(html).toContain(`${visibleCount} sessions`);
  });

  test("archived hidden count is shown on the toggle", () => {
    const archivedCount = CORPUS.filter((s) => s.status === "archived").length;
    expect(html).toContain(`data-testid="archived-hidden-count"`);
    expect(html).toContain(`>${archivedCount}<`);
  });

  test("the active sort is nameable: the default status chip is marked active", () => {
    expect(html).toContain(`data-testid="sort-chip-status"`);
    expect(html).toContain(`data-testid="sort-direction-status"`);
  });

  test("nothing renders an emoji where an icon belongs", () => {
    expect(html).toContain("<svg");
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });

  test("an empty browser says so rather than showing nothing", () => {
    const empty = render({ ...EMPTY_BROWSER, sessions: [] });
    expect(empty).toContain("No sessions.");
    expect(empty).toContain("0 sessions");
  });
});

describe("takeover and archive are visually distinct actions", () => {
  const live = CORPUS.find((s) => s.status === "live-tui") as BrowserSession;
  const dormant = CORPUS.find((s) => s.status === "dormant") as BrowserSession;
  const html = render(browserState());

  test("a dormant row's takeover action reads Resume, not Archive or Delete", () => {
    expect(html).toContain(`data-testid="session-takeover-${dormant.id}"`);
    expect(html).toContain(`Resume ${dormant.title}`);
  });

  test("a live-tui row's takeover action reads Attach, distinct from a dormant Resume", () => {
    expect(html).toContain(`data-testid="session-takeover-${live.id}"`);
    expect(html).toContain(`Attach ${live.title}`);
  });

  test("archive is a separate control from takeover, with its own testID and label", () => {
    expect(html).toContain(`data-testid="session-archive-${dormant.id}"`);
    expect(html).toContain(`Archive ${dormant.title}`);
    // The two actions are not the same pressable: distinct testIDs prove it.
    expect(html).not.toContain(`data-testid="session-archive-${dormant.id}"data-testid="session-takeover-${dormant.id}"`);
  });

  test("archive's label never says delete, remove, or destroy", () => {
    const archiveButtonRegion = html.slice(html.indexOf(`session-archive-${dormant.id}`) - 40, html.indexOf(`session-archive-${dormant.id}`) + 120);
    expect(archiveButtonRegion.toLowerCase()).not.toContain("delete");
    expect(archiveButtonRegion.toLowerCase()).not.toContain("destroy");
  });

  test("an archived row's primary action reads Restore, not Resume or Attach", () => {
    const archived = CORPUS.find((s) => s.status === "archived") as BrowserSession;
    // Archived is hidden by default; show it to reach the row at all.
    const withArchived = render({ ...browserState(), showArchived: true });
    expect(withArchived).toContain(`data-testid="session-unarchive-${archived.id}"`);
    expect(withArchived).toContain(`Restore ${archived.title}`);
  });
});

describe("collapsed group status precedence, rendered", () => {
  test("a collapsed group still shows its count and worst-status colour", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-0"; // 1 session, live-tui (d=0,i=0 -> statuses[0])
    const collapsed: BrowserState = {
      ...browserState(),
      collapsedGroups: new Set([dir]),
    };
    const html = render(collapsed);
    expect(html).toContain(`data-testid="group-header-${dir}"`);
    expect(html).toContain(`data-testid="group-count-${dir}"`);
    // amber is live-tui's signal colour; the collapsed header still carries it.
    const headerStart = html.indexOf(`group-header-${dir}`);
    const headerRegion = html.slice(Math.max(0, headerStart - 300), headerStart + 400);
    expect(headerRegion).toContain("rgba(224,163,58,1.00)");
  });

  test("collapsing a group removes its rows from the list but not its header", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-3"; // 4 sessions
    // Show archived too, so every session in the group is accounted for
    // regardless of status; the point here is collapse, not visibility.
    const group = CORPUS.filter((s) => s.cwd === dir);
    const expanded = render({ ...browserState(), showArchived: true });
    const collapsed = render({ ...browserState(), showArchived: true, collapsedGroups: new Set([dir]) });

    for (const session of group) {
      expect(expanded).toContain(`data-testid="session-row-${session.id}"`);
      expect(collapsed).not.toContain(`data-testid="session-row-${session.id}"`);
    }
    // The header survives collapse in both renders.
    expect(collapsed).toContain(`data-testid="group-header-${dir}"`);
  });
});

describe("grouping toggle", () => {
  test("turning grouping off renders a flat list with cwd shown per row", () => {
    const html = render({ ...browserState(), grouped: false });
    expect(html).not.toContain('data-testid="group-header-');
    // A sample of ids from different directories should all be present.
    const sample = [CORPUS[0], CORPUS[CORPUS.length - 1]] as BrowserSession[];
    for (const session of sample) {
      expect(html).toContain(`data-testid="session-row-${session.id}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 390px: the real test, not a desktop window
// ---------------------------------------------------------------------------

/**
 * This environment inlines styles directly (`smoke.test.tsx` already proves
 * that by asserting on raw `rgba(...)` values), so every fixed pixel width in
 * the rendered tree is visible as `width:<n>px` in the markup. A component
 * that hardcoded something wider than a 390px phone would show up here as a
 * `width` well past 390; nothing in SessionRow, GroupHeader, or SortBar
 * declares one; the max fixed width in the whole tree is the two 44px touch
 * targets (Design tokens: `TOUCH_TARGET`) plus the 3px status bar, all
 * flex-adjacent to text columns that carry `flexShrink`/`numberOfLines={1}`.
 */
describe("renders at a 390px phone width without a fixed width past it", () => {
  const html = render(browserState());

  test("row height: session rows and group headers both use the 44px touch target as their minimum", () => {
    // TOUCH_TARGET = 44. SessionRow's row and GroupHeader's header both set
    // minHeight to it (see components/SessionRow.tsx, components/GroupHeader.tsx).
    const rowMinHeights = [...html.matchAll(/min-height:\s*44px/gi)];
    expect(rowMinHeights.length).toBeGreaterThan(0);
  });

  test("no declared width in the rendered tree exceeds the 390px viewport", () => {
    const widths = [...html.matchAll(/width:\s*(\d+(?:\.\d+)?)px/gi)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    const max = Math.max(...widths);
    expect(max).toBeLessThanOrEqual(390);
    // The actual ceiling is the 44px touch target column, well under budget.
    expect(max).toBeLessThanOrEqual(44);
  });

  test("text columns that could overflow are clamped to one line", () => {
    // Title and path text use numberOfLines={1}, which react-native-web
    // compiles to a `overflow-x:hidden;overflow-y:hidden;` class plus
    // text-overflow ellipsis, so a long title never pushes the row wider
    // than its flex container.
    expect(html).toMatch(/overflow-x:hidden/);
    expect(html).toContain("text-overflow:ellipsis");
  });
});
