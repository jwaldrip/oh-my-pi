/**
 * A transient message.
 *
 * Not a modal: an operator mid-turn must never have to dismiss something before
 * they can read their own log. It sits above the composer, takes a tap to
 * clear, and announces itself politely rather than interrupting whatever a
 * screen reader was already saying.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Label } from "../design/text.tsx";
import { ground, ink, space } from "../design/tokens.ts";

export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }): JSX.Element {
  return (
    <Pressable
      testID="toast"
      accessibilityRole="button"
      accessibilityLabel={`${message}. Dismiss.`}
      accessibilityLiveRegion="polite"
      onPress={onDismiss}
      style={styles.toast}
    >
      <Label color={ink.bright}>{message}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: space.wide,
    right: space.wide,
    bottom: space.gulf * 2.5,
    padding: space.step,
    backgroundColor: ground.active,
    borderLeftWidth: 2,
    borderLeftColor: ink.plain,
  },
});
