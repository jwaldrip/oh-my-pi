/**
 * One task, as a strip in the sidebar.
 *
 * A task is a named unit of work, not the session it runs in: the strip shows
 * what was asked and how it's going. "Where it ran" (`task.agentId`) is
 * deliberately not inlined here — that is an explicit act (`onOpenSession`
 * on the screen that composes this), not a second identity every strip has
 * to carry.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TASK_STATE_LABELS, TASK_STATE_SIGNALS } from "../cowork/tasks.ts";
import type { Task } from "../cowork/types.ts";
import { elapsed } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface TaskCardProps {
  task: Task;
  selected: boolean;
  onSelect: (task: Task) => void;
  /** Injected so a test can pin the strip clocks. */
  now?: number;
}

export function TaskCard({ task, selected, onSelect, now }: TaskCardProps): JSX.Element {
  const tone = signal[TASK_STATE_SIGNALS[task.state]];

  return (
    <Pressable
      testID={`task-${task.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${task.title}, ${TASK_STATE_LABELS[task.state]}`}
      onPress={() => onSelect(task)}
      style={({ pressed }) => [styles.card, selected && styles.selected, pressed && { backgroundColor: ground.active }]}
    >
      <View style={[styles.bar, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <View style={styles.headline}>
          <Title numberOfLines={1} style={styles.name}>
            {task.title}
          </Title>
          <Kicker color={tone} testID={`task-${task.id}-state`}>
            {TASK_STATE_LABELS[task.state]}
          </Kicker>
        </View>

        <View style={styles.metaRow}>
          {task.skillName !== undefined ? (
            <View style={styles.skillTag}>
              <Glyph name="skill" size={10} color={ink.faint} />
              <Label color={ink.muted} numberOfLines={1}>{`/${task.skillName}`}</Label>
            </View>
          ) : (
            <Label color={ink.muted} numberOfLines={1} style={styles.prompt}>
              {task.prompt}
            </Label>
          )}
          <Data color={ink.faint}>{elapsed(task.updatedAt, now)}</Data>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    minHeight: TOUCH_TARGET * 1.2,
  },
  selected: { backgroundColor: ground.raised },
  bar: { width: 3 },
  body: { flex: 1, paddingVertical: space.snug, paddingHorizontal: space.wide, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  name: { flexShrink: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: space.snug },
  skillTag: { flexDirection: "row", alignItems: "center", gap: space.tight, flexShrink: 1 },
  prompt: { flex: 1 },
});
