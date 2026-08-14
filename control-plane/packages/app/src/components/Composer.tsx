/**
 * Where the operator says something.
 *
 * Two states, and they are not the same control. Idle, it sends. Mid-turn, the
 * send becomes an interrupt, because the useful thing to do while an agent is
 * working is stop it, and queueing a second prompt behind the first is how two
 * instructions get interleaved into one confused turn.
 *
 * The field stays editable while a turn runs so the next prompt can be typed
 * during it. Only sending is held.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";

export interface ComposerProps {
  /** False when there is no link or no strip selected. */
  enabled: boolean;
  /** True while a turn is in flight; the action becomes an interrupt. */
  busy: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function Composer({ enabled, busy, onSubmit, onCancel }: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const canSend = enabled && !busy && trimmed.length > 0;

  return (
    <View style={styles.composer}>
      <TextInput
        testID="composer-input"
        style={[styles.field, type.body, !enabled && styles.fieldOff]}
        value={text}
        onChangeText={setText}
        editable={enabled}
        multiline
        placeholder={enabled ? "Say something to this agent" : "No link"}
        placeholderTextColor={ink.faint}
        // Enter sends on a keyboard; Shift+Enter is a newline, which is what
        // `multiline` plus `blurOnSubmit: false` leaves working.
        submitBehavior="submit"
        onSubmitEditing={() => {
          if (!canSend) return;
          onSubmit(trimmed);
          setText("");
        }}
      />

      {busy ? (
        <Pressable
          testID="composer-cancel"
          accessibilityRole="button"
          accessibilityLabel="Interrupt this turn"
          onPress={onCancel}
          style={({ pressed }) => [
            styles.action,
            { borderColor: signal.oxide },
            pressed && { backgroundColor: ground.active },
          ]}
        >
          <Glyph name="interrupt" size={14} color={signal.oxide} />
          <Label color={signal.oxide}>Stop</Label>
        </Pressable>
      ) : (
        <Pressable
          testID="composer-send"
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={() => {
            onSubmit(trimmed);
            setText("");
          }}
          style={({ pressed }) => [
            styles.action,
            { borderColor: canSend ? signal.sage : ground.edge },
            pressed && { backgroundColor: ground.active },
          ]}
        >
          <Glyph name="send" size={14} color={canSend ? signal.sage : ink.faint} />
          <Label color={canSend ? signal.sage : ink.faint}>Send</Label>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.snug,
    padding: space.step,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  field: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    maxHeight: 140,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    color: ink.bright,
    backgroundColor: ground.base,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  fieldOff: { color: ink.faint },
  action: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
  },
});
