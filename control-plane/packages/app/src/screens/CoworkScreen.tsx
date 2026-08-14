/**
 * The Cowork surface: the task sidebar as primary navigation, with skills,
 * connectors, and plugins one tap away.
 *
 * Two layouts, one component tree — the same split the console already draws
 * at `SPLIT_WIDTH`, applied to a different shape of screen.
 *
 * Wide (>= SPLIT_WIDTH): a fixed nav rail, the task sidebar, and a content
 * pane sit side by side, because there is room for the primary surface and
 * whatever it opens onto at once — the same reasoning `Console` already
 * applies to the bay and the log.
 *
 * Narrow (down to 390px): a permanent side rail has nowhere to go — at 390px
 * a 240px sidebar plus a 64px rail leaves under 90px for content, which is
 * not a screen, it's a sliver. So the rail becomes a bottom tab bar (four
 * destinations, each a full screen), the sidebar's task list becomes the
 * Tasks tab's own full-screen content, and selecting a task pushes its detail
 * over the list with a back button — the same push-not-split pattern
 * `SessionScreen` already uses for the fleet vs. one agent's log. A bottom
 * tab bar beats a hamburger drawer here because these are four permanent
 * peer destinations an operator returns to constantly, not settings visited
 * once — the cost of always-visible icons is worth it at that frequency.
 */

import type { JSX } from "react";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { taskListView } from "../cowork/tasks.ts";
import type { TaskListState } from "../cowork/tasks.ts";
import type { ConnectorSummary, SkillSummary, Task } from "../cowork/types.ts";
import { ConnectorsView, PluginsView, SkillsView } from "../components/CoworkCatalogueViews.tsx";
import type { NewTaskInput } from "../components/TaskSidebar.tsx";
import { TaskDetail } from "../components/TaskDetail.tsx";
import { TaskSidebar } from "../components/TaskSidebar.tsx";
import { useSplitLayout } from "../design/layout.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export type CoworkView = "tasks" | "skills" | "connectors" | "plugins";

interface Destination {
  id: CoworkView;
  label: string;
  glyph: GlyphName;
}

const DESTINATIONS: readonly Destination[] = [
  { id: "tasks", label: "Tasks", glyph: "tasks" },
  { id: "skills", label: "Skills", glyph: "skill" },
  { id: "connectors", label: "Connectors", glyph: "connector" },
  { id: "plugins", label: "Plugins", glyph: "plugin" },
];

export interface CoworkScreenProps {
  tasks: TaskListState;
  skills: readonly SkillSummary[];
  connectors: readonly ConnectorSummary[];
  onStartTask: (input: NewTaskInput) => void;
  onInvokeSkill: (skill: SkillSummary) => void;
  onOpenSession: (agentId: string) => void;
  now?: number;
}

export function CoworkScreen(props: CoworkScreenProps): JSX.Element {
  const { tasks, skills, connectors, onStartTask, onInvokeSkill, onOpenSession, now } = props;
  const split = useSplitLayout();
  const [view, setView] = useState<CoworkView>("tasks");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const listView = useMemo(() => taskListView(tasks), [tasks]);
  const selectedTask = selectedTaskId === null ? null : (tasks.tasks.get(selectedTaskId) ?? null);

  const selectTask = (task: Task): void => {
    setSelectedTaskId(task.id);
    setView("tasks");
  };

  const startTask = (input: NewTaskInput): void => {
    setSelectedTaskId(null);
    onStartTask(input);
  };

  const sidebar = (
    <TaskSidebar
      tasks={listView}
      skills={skills}
      selectedTaskId={selectedTaskId}
      onSelectTask={selectTask}
      onStartTask={startTask}
      now={now}
    />
  );

  const content = (() => {
    if (view === "skills") return <SkillsView skills={skills} onInvoke={onInvokeSkill} />;
    if (view === "connectors") return <ConnectorsView connectors={connectors} />;
    if (view === "plugins") return <PluginsView skills={skills} connectors={connectors} />;
    if (selectedTask !== null) return <TaskDetail task={selectedTask} onOpenSession={onOpenSession} now={now} />;
    return <TasksEmpty />;
  })();

  if (split) {
    return (
      <View style={styles.wide} testID="cowork-screen">
        <Nav orientation="side" active={view} onSelect={setView} />
        <View style={styles.sidebarColumn}>{sidebar}</View>
        <View style={styles.contentColumn}>{content}</View>
      </View>
    );
  }

  // Narrow: the active tab owns the whole screen. The tasks tab shows the
  // sidebar's own list (not the split layout's "select a task" placeholder)
  // until a task is selected, then pushes its detail over the list rather
  // than splitting the width between them.
  const showingTaskList = view === "tasks" && selectedTask === null;
  const narrowContent = showingTaskList ? sidebar : content;

  return (
    <View style={styles.narrow} testID="cowork-screen">
      {view === "tasks" && selectedTask !== null ? (
        <Pressable
          testID="task-detail-back"
          accessibilityRole="button"
          accessibilityLabel="Back to tasks"
          onPress={() => setSelectedTaskId(null)}
          style={styles.back}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain}>Tasks</Label>
        </Pressable>
      ) : null}
      <View style={styles.narrowContent}>{narrowContent}</View>
      <Nav orientation="bottom" active={view} onSelect={setView} />
    </View>
  );
}

function TasksEmpty(): JSX.Element {
  return (
    <View style={styles.empty} testID="task-detail-empty">
      <Glyph name="tasks" size={22} color={ground.edge} />
      <Label color={ink.muted}>Select a task to see its detail.</Label>
    </View>
  );
}

function Nav({
  orientation,
  active,
  onSelect,
}: {
  orientation: "side" | "bottom";
  active: CoworkView;
  onSelect: (view: CoworkView) => void;
}): JSX.Element {
  return (
    <View style={orientation === "side" ? styles.navSide : styles.navBottom} testID="cowork-nav">
      {DESTINATIONS.map((destination) => {
        const isActive = destination.id === active;
        return (
          <Pressable
            key={destination.id}
            testID={`cowork-nav-${destination.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={destination.label}
            onPress={() => onSelect(destination.id)}
            style={({ pressed }) => [
              orientation === "side" ? styles.navItemSide : styles.navItemBottom,
              pressed && { backgroundColor: ground.active },
            ]}
          >
            <Glyph name={destination.glyph} size={16} color={isActive ? signal.amber : ink.muted} />
            <Kicker color={isActive ? signal.amber : ink.muted}>{destination.label}</Kicker>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wide: { flex: 1, flexDirection: "row", backgroundColor: ground.base },
  narrow: { flex: 1, backgroundColor: ground.base },
  narrowContent: { flex: 1 },
  sidebarColumn: { width: 300, borderRightWidth: stroke.hair, borderRightColor: ground.line },
  contentColumn: { flex: 1 },
  navSide: {
    width: 64,
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
    paddingVertical: space.step,
    gap: space.snug,
  },
  navItemSide: { alignItems: "center", gap: space.tight, paddingVertical: space.snug },
  navBottom: {
    flexDirection: "row",
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
    backgroundColor: ground.surface,
  },
  navItemBottom: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.tight, minHeight: TOUCH_TARGET * 1.1 },
  back: { flexDirection: "row", alignItems: "center", gap: space.tight, padding: space.step },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.step },
});
