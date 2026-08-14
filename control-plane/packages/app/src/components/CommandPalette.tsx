/**
 * The `/` menu: type to filter, press a row to invoke.
 *
 * Opened by typing `/` in the task composer, closed by invoking a skill or by
 * clearing the query. Not a separate screen — a floating list over the
 * composer it grew out of, because the point of a slash command is not
 * leaving the place typing it started.
 */

import type { JSX } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { filterSkills, skillInvocation } from "../cowork/catalog.ts";
import type { SkillSummary } from "../cowork/types.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Body, Label, Title } from "../design/text.tsx";
import { ground, ink, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

const KIND_GLYPHS: Record<SkillSummary["kind"], GlyphName> = { skill: "skill", command: "commands" };

export interface CommandPaletteProps {
  skills: readonly SkillSummary[];
  query: string;
  onInvoke: (skill: SkillSummary) => void;
}

export function CommandPalette({ skills, query, onInvoke }: CommandPaletteProps): JSX.Element {
  const matches = filterSkills(skills, query);

  return (
    <View style={styles.palette} testID="command-palette">
      <FlatList
        testID="command-palette-list"
        data={matches}
        keyExtractor={(skill) => `${skill.kind}:${skill.name}:${skill.source}`}
        renderItem={({ item }) => (
          <Pressable
            testID={`command-${item.kind}-${item.name}`}
            accessibilityRole="button"
            accessibilityLabel={`Invoke ${skillInvocation(item)}`}
            onPress={() => onInvoke(item)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: ground.active }]}
          >
            <Glyph name={KIND_GLYPHS[item.kind]} size={13} color={ink.plain} />
            <View style={styles.rowBody}>
              <Title numberOfLines={1}>{skillInvocation(item)}</Title>
              <Body color={ink.muted} numberOfLines={1}>
                {item.description}
              </Body>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID="command-palette-empty">
            <Label color={ink.muted}>{`No skill matches "${query}".`}</Label>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  palette: { maxHeight: 280, backgroundColor: ground.raised, borderWidth: stroke.hair, borderColor: ground.edge },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  rowBody: { flex: 1, gap: space.hair },
  empty: { padding: space.step, alignItems: "center" },
});
