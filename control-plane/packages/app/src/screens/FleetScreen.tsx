/**
 * The session browser: every session this device has ever launched, unless
 * explicitly archived.
 *
 * Rows are sessions, not just live agents: a session nobody has touched today
 * is still a first-class row, because the point of a browser over a fleet is
 * finding the thing you are not currently looking at. Grouping by working
 * directory is the primary organiser, on the same reasoning the contract
 * states it: 93 groups over 305 sessions is unusable flat, and grouping is
 * what makes "which project was that in" answerable at a glance. A cwd is
 * data about a session here, a display grouping, never its identity.
 *
 * This screen is fully controlled. It owns no state of its own; `browser` is
 * the whole picture (sessions, sort, archive visibility, grouping, which
 * groups are collapsed) and every gesture becomes a callback. That is what
 * lets a canned `BrowserState` produce byte-identical markup to a live one,
 * the same discipline `console/state.ts` applies to the socket.
 */

import type { JSX } from "react";
import { useMemo } from "react";
import { FlatList, Pressable, SectionList, StyleSheet, View } from "react-native";
import type { BrowserSession, BrowserState, SortField } from "../session/browser.ts";
import { browserView } from "../session/browser.ts";
import { GroupHeader } from "../components/GroupHeader.tsx";
import { SessionRow } from "../components/SessionRow.tsx";
import { SortBar } from "../components/SortBar.tsx";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface FleetScreenProps {
  browser: BrowserState;
  onSort: (field: SortField) => void;
  onToggleGroup: (cwd: string) => void;
  onToggleGrouped: () => void;
  onToggleArchived: () => void;
  onTakeover: (session: BrowserSession) => void;
  onArchive: (session: BrowserSession) => void;
  onUnarchive: (session: BrowserSession) => void;
  /** Injected so a test can pin the row clocks instead of racing the wall. */
  now?: number;
}

export function FleetScreen({
  browser,
  onSort,
  onToggleGroup,
  onToggleGrouped,
  onToggleArchived,
  onTakeover,
  onArchive,
  onUnarchive,
  now,
}: FleetScreenProps): JSX.Element {
  const view = useMemo(() => browserView(browser), [browser]);
  // Virtualization's default `initialNumToRender` (10) is tuned for a feed a
  // person scrolls; a fleet browser is closer to a directory listing, and the
  // contract's own machine has 305 sessions across 93 groups. Rendering the
  // whole visible set eagerly is cheap at that scale and means a session is
  // never invisible to a search, a screen reader sweep, or a static render
  // that never fires the scroll/layout events which would otherwise grow the
  // window. React Native's virtualizer measures this in an estimated cell
  // count rather than a literal 1:1 slot count, so the multiplier here is an
  // empirically-checked safety margin, not the raw section+row total.
  const rows = view.visibleCount + view.groups.length;
  const initialNumToRender = rows * 2 + 50;

  return (
    <SafeScreen testID="fleet">
      <View style={styles.head}>
        <Glyph name="bay" size={16} color={ink.plain} />
        <Display heading testID="fleet-title">
          Sessions
        </Display>
        <Kicker color={ink.muted} testID="fleet-count">
          {`${view.visibleCount} ${view.visibleCount === 1 ? "session" : "sessions"}`}
        </Kicker>
        <Pressable
          testID="grouped-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.grouped }}
          accessibilityLabel={browser.grouped ? "Grouped by directory" : "Flat list"}
          onPress={onToggleGrouped}
          style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="folder" size={12} color={browser.grouped ? signal.amber : ink.faint} />
        </Pressable>
        <Pressable
          testID="archived-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.showArchived }}
          accessibilityLabel={
            browser.showArchived
              ? "Hide archived sessions"
              : `Show ${view.hiddenArchived} archived ${view.hiddenArchived === 1 ? "session" : "sessions"}`
          }
          onPress={onToggleArchived}
          style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="archive" size={12} color={browser.showArchived ? signal.amber : ink.faint} />
          {!browser.showArchived && view.hiddenArchived > 0 ? (
            <Label color={ink.faint} testID="archived-hidden-count">
              {view.hiddenArchived}
            </Label>
          ) : null}
        </Pressable>
      </View>

      <SortBar sort={browser.sort} onChange={onSort} />

      {browser.grouped ? (
        <SectionList
          testID="fleet-list"
          sections={view.groups.map((group) => ({
            cwd: group.cwd,
            group,
            data: browser.collapsedGroups.has(group.cwd) ? [] : group.sessions,
          }))}
          keyExtractor={(session: BrowserSession) => session.id}
          renderSectionHeader={({ section }) => (
            <GroupHeader
              group={section.group}
              collapsed={browser.collapsedGroups.has(section.cwd)}
              onToggle={onToggleGroup}
            />
          )}
          renderItem={({ item }: { item: BrowserSession }) => (
            <SessionRow
              session={item}
              showCwd={false}
              onTakeover={onTakeover}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              now={now}
            />
          )}
          stickySectionHeadersEnabled
          initialNumToRender={initialNumToRender}
          ListEmptyComponent={<Empty />}
        />
      ) : (
        <FlatList
          testID="fleet-list"
          data={view.flatSessions as BrowserSession[]}
          keyExtractor={(session) => session.id}
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              showCwd
              onTakeover={onTakeover}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              now={now}
            />
          )}
          initialNumToRender={initialNumToRender}
          ListEmptyComponent={<Empty />}
        />
      )}
    </SafeScreen>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="fleet-empty">
      <Glyph name="bay" size={26} color={ground.edge} />
      <Body color={ink.plain}>No sessions.</Body>
      <Label color={ink.muted}>Start one with ompd agents create on the machine running the daemon.</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    justifyContent: "center",
    marginLeft: space.tight,
  },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
});
