/**
 * The task sidebar: start one, see what's running, return to a past one.
 *
 * This is not the session browser — a session is where a task ran, and that
 * view groups by directory and by machine state. This groups by what was
 * asked and how it's going, and never touches a filesystem path or a host.
 *
 * The composer doubles as the `/` menu's home: typing `/` opens
 * `CommandPalette` inline rather than navigating to it, because for an
 * operator who already knows the skill's name, a second screen would be
 * slower than just finishing the word.
 */

import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { NewTaskInput, TaskListView } from "../cowork/tasks.ts";
import type { SkillSummary, Task } from "../cowork/types.ts";
import { Glyph } from "../design/icons.tsx";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { TaskCard } from "./TaskCard.tsx";

export type { NewTaskInput } from "../cowork/tasks.ts";

export interface TaskSidebarProps {
  tasks: TaskListView;
  skills: readonly SkillSummary[];
  selectedTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onStartTask: (input: NewTaskInput) => void;
  now?: number;
}

/** A composer draft longer than this is titled by truncation, not repeated verbatim in the strip's headline. */
const TITLE_CLAMP = 48;

export function TaskSidebar({ tasks, skills, selectedTaskId, onSelectTask, onStartTask, now }: TaskSidebarProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const paletteOpen = draft.startsWith("/") && trimmed.length > 0;
  const total = tasks.inFlight.length + tasks.recent.length;

  const start = (skillName?: string): void => {
    if (trimmed.length === 0) return;
    const title = skillName !== undefined ? `/${skillName}` : trimmed.slice(0, TITLE_CLAMP);
    onStartTask({ title, prompt: trimmed, skillName });
    setDraft("");
  };

  return (
    <View style={styles.sidebar} testID="task-sidebar">
      <View style={styles.head}>
        <Glyph name="tasks" size={16} color={ink.plain} />
        <Kicker color={ink.muted} testID="task-sidebar-count">{`${total} ${total === 1 ? "task" : "tasks"}`}</Kicker>
      </View>

      <View style={styles.composer}>
        <View style={styles.composerRow}>
          <Glyph name="newTask" size={13} color={ink.faint} />
          <TextInput
            testID="task-composer-input"
            style={[styles.field, type.body]}
            value={draft}
            onChangeText={setDraft}
            placeholder="Start a task, or / for a skill"
            placeholderTextColor={ink.faint}
            onSubmitEditing={() => start()}
          />
        </View>
        {paletteOpen ? <CommandPalette skills={skills} query={draft} onInvoke={(skill) => start(skill.name)} /> : null}
      </View>

      <ScrollView testID="task-sidebar-scroll">
        {tasks.inFlight.length > 0 ? (
          <View>
            <Kicker color={ink.muted} style={styles.sectionLabel}>
              In flight
            </Kicker>
            {tasks.inFlight.map((task) => (
              <TaskCard key={task.id} task={task} selected={task.id === selectedTaskId} onSelect={onSelectTask} now={now} />
            ))}
          </View>
        ) : null}

        {tasks.recent.length > 0 ? (
          <View>
            <Kicker color={ink.muted} style={styles.sectionLabel}>
              Recent
            </Kicker>
            {tasks.recent.map((task) => (
              <TaskCard key={task.id} task={task} selected={task.id === selectedTaskId} onSelect={onSelectTask} now={now} />
            ))}
          </View>
        ) : null}

        {total === 0 ? (
          <View style={styles.empty} testID="task-sidebar-empty">
            <Glyph name="tasks" size={22} color={ground.edge} />
            <Body color={ink.plain}>No tasks yet.</Body>
            <Label color={ink.muted}>Start one above, or type / to invoke a skill.</Label>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: { flex: 1, backgroundColor: ground.base },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  composer: {
    padding: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
    gap: space.snug,
  },
  composerRow: { flexDirection: "row", alignItems: "center", gap: space.snug },
  field: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  sectionLabel: { paddingHorizontal: space.wide, paddingTop: space.step, paddingBottom: space.tight, letterSpacing: 1 },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
});
