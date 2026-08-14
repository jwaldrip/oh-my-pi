/**
 * A skill, as an invocable card.
 *
 * Cowork's model is a card that runs the thing, not a row that describes it.
 * The whole card is the press target: for an operator with dozens of skills,
 * the card *is* the command, the same way typing `/name` and hitting return
 * would be.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { deriveOrigin, skillInvocation } from "../cowork/catalog.ts";
import type { SkillSummary } from "../cowork/types.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Body, Data, Title } from "../design/text.tsx";
import { ground, ink, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import { PluginBadge } from "./PluginBadge.tsx";

const KIND_GLYPHS: Record<SkillSummary["kind"], GlyphName> = { skill: "skill", command: "commands" };
const KIND_LABELS: Record<SkillSummary["kind"], string> = { skill: "skill", command: "command" };

export interface SkillCardProps {
  skill: SkillSummary;
  onInvoke: (skill: SkillSummary) => void;
}

export function SkillCard({ skill, onInvoke }: SkillCardProps): JSX.Element {
  const origin = deriveOrigin(skill.providerName);
  const groupLabel = skill.pluginName ?? skill.providerName ?? skill.source;
  const invocation = skillInvocation(skill);

  return (
    <Pressable
      testID={`skill-${skill.kind}-${skill.name}`}
      accessibilityRole="button"
      accessibilityLabel={`Run ${invocation}: ${skill.description}`}
      onPress={() => onInvoke(skill)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Glyph name={KIND_GLYPHS[skill.kind]} size={16} color={ink.plain} />
      <View style={styles.body}>
        <View style={styles.headline}>
          <Title numberOfLines={1} style={styles.name} testID={`skill-${skill.kind}-${skill.name}-invocation`}>
            {invocation}
          </Title>
          <Data color={ink.faint}>{KIND_LABELS[skill.kind]}</Data>
        </View>
        <Body color={ink.plain} numberOfLines={2}>
          {skill.description}
        </Body>
        <PluginBadge origin={origin} label={groupLabel} testID={`skill-${skill.kind}-${skill.name}-origin`} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: space.snug,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    padding: space.step,
    minHeight: TOUCH_TARGET,
  },
  pressed: { backgroundColor: ground.active },
  body: { flex: 1, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  name: { flexShrink: 1 },
});
