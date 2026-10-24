import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { ground, ink, signal, space, stroke, type } from "../design/tokens.ts";

/** The roles an operator cycles through while selecting an interactive model. */
export const ROLE_CYCLE = ["default", "smol", "slow", "plan"] as const;
export type CycleRole = (typeof ROLE_CYCLE)[number];

const LABELS: Record<CycleRole, string> = {
  default: "Default",
  smol: "Fast",
  slow: "Thinking",
  plan: "Architect",
};

export function nextRole(value: CycleRole, direction: -1 | 1): CycleRole {
  const index = ROLE_CYCLE.indexOf(value);
  return ROLE_CYCLE[(index + direction + ROLE_CYCLE.length) % ROLE_CYCLE.length] ?? ROLE_CYCLE[0];
}

export interface RoleCyclePickerProps {
  value: CycleRole;
  onChange: (role: CycleRole) => void;
  disabled?: boolean;
}

/** A compact, keyboard-accessible role carousel with no hidden selection state. */
export function RoleCyclePicker({ value, onChange, disabled = false }: RoleCyclePickerProps): JSX.Element {
  const previous = nextRole(value, -1);
  const following = nextRole(value, 1);

  return (
    <View style={styles.root} testID="role-cycle-picker">
      <Pressable
        accessibilityLabel={`Previous role, ${LABELS[previous]}`}
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => onChange(previous)}
        style={({ pressed }) => [styles.button, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
        testID="role-cycle-previous"
      >
        <Glyph name="back" color={disabled ? ink.faint : ink.plain} />
      </Pressable>
      <View accessibilityLiveRegion="polite" style={styles.value}>
        <Text style={styles.label}>{LABELS[value]}</Text>
        <Text style={styles.role}>@{value}</Text>
      </View>
      <Pressable
        accessibilityLabel={`Next role, ${LABELS[following]}`}
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => onChange(following)}
        style={({ pressed }) => [styles.button, styles.next, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
        testID="role-cycle-next"
      >
        <Glyph name="back" color={disabled ? ink.faint : ink.plain} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    backgroundColor: ground.raised,
    borderColor: ground.edge,
    borderRadius: 10,
    borderWidth: stroke.hair,
    flexDirection: "row",
    minHeight: 52,
  },
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
  },
  disabled: { opacity: 0.45 },
  label: { ...type.title, color: ink.plain },
  next: { transform: [{ rotate: "180deg" }] },
  pressed: { backgroundColor: ground.active },
  role: { ...type.code, color: signal.violet, marginTop: space.hair },
  value: { alignItems: "center", flex: 1, paddingHorizontal: space.snug },
});
