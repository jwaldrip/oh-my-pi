/**
 * One place that owns the system insets.
 *
 * Notch, Dynamic Island, home indicator, and the Android status/nav bars are
 * not layout decoration: a header drawn under them is untappable, and a
 * composer drawn under the home indicator is unusable. Every full-screen
 * surface goes through this shell so a new screen cannot forget.
 *
 * The inset lives on an outer shell. The caller's style, including any design
 * padding, lives on an inner content view. That split is the whole point: the
 * two never fight over the same `padding*` keys, so a pairing form that wants
 * `space.loose` still gets it on a phone with a notch, and a web build with
 * zero insets still keeps its design padding.
 */

import type { JSX, ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ground } from "./tokens.ts";

export function SafeScreen({
  children,
  style,
  testID,
  edges = { top: true, bottom: true, left: true, right: true },
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Which edges take the system inset. A screen that already has a sticky
   * bottom composer still wants the bottom inset on that composer, not on the
   * outer shell twice; pass `bottom: false` there and pad the composer itself.
   */
  edges?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={[
        styles.shell,
        {
          paddingTop: edges.top === false ? 0 : insets.top,
          paddingBottom: edges.bottom === false ? 0 : insets.bottom,
          paddingLeft: edges.left === false ? 0 : insets.left,
          paddingRight: edges.right === false ? 0 : insets.right,
        },
      ]}
    >
      <View style={[styles.content, style]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: ground.base },
  content: { flex: 1 },
});
