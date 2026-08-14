/**
 * The sort control.
 *
 * A list whose order you cannot name is a list you do not trust: this is the
 * one place the active field and its direction are always on screen, not
 * tucked behind a menu that has to be opened to be checked. Tapping a chip
 * that is already active flips its direction; tapping another chip switches
 * to it.
 */

import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import type { SortField, SortSpec } from "../session/browser.ts";
import { SORT_LABELS } from "../session/browser.ts";
import { Data, Kicker } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

const FIELDS: readonly SortField[] = ["status", "age", "lastActive", "messageCount", "size"];

export interface SortBarProps {
  sort: SortSpec;
  onChange: (field: SortField) => void;
}

export function SortBar({ sort, onChange }: SortBarProps): JSX.Element {
  return (
    <ScrollView
      testID="sort-bar"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {FIELDS.map((field) => {
        const active = sort.field === field;
        return (
          <Pressable
            key={field}
            testID={`sort-chip-${field}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              active ? `Sort by ${SORT_LABELS[field]}, ${sort.direction === "asc" ? "ascending" : "descending"}` : `Sort by ${SORT_LABELS[field]}`
            }
            onPress={() => {
              onChange(field);
            }}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && { backgroundColor: ground.active },
            ]}
          >
            <Kicker color={active ? signal.amber : ink.muted}>{SORT_LABELS[field]}</Kicker>
            {active ? (
              <Data color={signal.amber} testID={`sort-direction-${field}`}>
                {sort.direction === "asc" ? "\u2191" : "\u2193"}
              </Data>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { borderBottomWidth: stroke.hair, borderBottomColor: ground.line, backgroundColor: ground.surface },
  row: { flexDirection: "row", paddingHorizontal: space.snug, gap: space.tight },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    height: TOUCH_TARGET,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  chipActive: { borderBottomColor: signal.amber },
});
