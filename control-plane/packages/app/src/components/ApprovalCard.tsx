/**
 * A clearance request: the one card in the app that is a decision rather than a
 * record.
 *
 * Three properties are load-bearing. It cannot be mistaken for a tool card, so
 * it is the only entry with a full ochre border rather than a rail. Allow and
 * reject are the same size and the same weight, because making the safe answer
 * larger is how an operator learns to hit the big button without reading. And a
 * settled card stays in place showing what was decided, because a clearance
 * that vanishes on tap leaves no evidence of what was approved.
 *
 * `always` is a separate control rather than a checkbox on `allow`. Granting a
 * standing permission is a different act from approving one command, and a
 * modifier riding on a button is how it gets granted by accident.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { Glyph } from "../design/icons.tsx";
import { Body, Code, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { ApprovalEntry } from "../session/model.ts";

export interface ApprovalCardProps {
  entry: ApprovalEntry;
  /** False when this device's pairing does not hold the approve scope. */
  canApprove: boolean;
  /** Why the controls are disabled, when they are. Shown rather than implied. */
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
}

export function ApprovalCard({ entry, canApprove, refusal, onDecide }: ApprovalCardProps): JSX.Element {
  const settled = entry.decision !== null;
  const tone = settled ? (entry.decision === "allow" ? signal.sage : signal.oxide) : signal.ochre;
  const preview = describeInput(entry.input);

  return (
    <View style={[styles.card, { borderColor: tone }]} testID={`approval-${entry.requestId}`}>
      <View style={[styles.head, { backgroundColor: settled ? ground.raised : signalWash.ochre }]}>
        <Glyph name="clearance" size={13} color={tone} />
        <Kicker color={tone} testID={`approval-state-${entry.requestId}`}>
          {settled ? (entry.decision === "allow" ? "allowed" : "rejected") : "clearance"}
        </Kicker>
        <Label color={ink.muted} numberOfLines={1} style={styles.tool}>
          {entry.tool}
        </Label>
      </View>

      <View style={styles.body}>
        <Body testID={`approval-title-${entry.requestId}`}>{entry.title}</Body>
        {preview !== null ? (
          <View style={styles.input}>
            <Code numberOfLines={8}>{preview}</Code>
          </View>
        ) : null}
      </View>

      {settled ? null : canApprove ? (
        <View style={styles.actions}>
          <Decision
            testID={`approval-allow-${entry.requestId}`}
            glyph="allow"
            label="Allow"
            tone={signal.sage}
            onPress={() => {
              onDecide(entry.requestId, "allow", "once");
            }}
          />
          <Decision
            testID={`approval-deny-${entry.requestId}`}
            glyph="deny"
            label="Reject"
            tone={signal.oxide}
            onPress={() => {
              onDecide(entry.requestId, "deny", "once");
            }}
          />
          <Decision
            testID={`approval-always-${entry.requestId}`}
            glyph="allow"
            label="Always"
            tone={ink.muted}
            onPress={() => {
              onDecide(entry.requestId, "allow", "always");
            }}
          />
        </View>
      ) : (
        <View style={styles.refusal}>
          <Glyph name="unpair" size={11} color={ink.muted} />
          <Label color={ink.muted} testID={`approval-refusal-${entry.requestId}`}>
            {refusal ?? "This device does not hold the approve scope."}
          </Label>
        </View>
      )}
    </View>
  );
}

function Decision({
  glyph,
  label,
  tone,
  onPress,
  testID,
}: {
  glyph: "allow" | "deny";
  label: string;
  tone: string;
  onPress: () => void;
  testID: string;
}): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.decision, { borderColor: tone }, pressed && { backgroundColor: ground.active }]}
    >
      <Glyph name={glyph} size={12} color={tone} />
      <Label color={tone}>{label}</Label>
    </Pressable>
  );
}

/**
 * The command, as text, when the payload has one worth showing. A tool's raw
 * input is arbitrary JSON and printing all of it turns a decision into a
 * reading exercise, so the shell-shaped fields win and everything else falls
 * back to compact JSON.
 */
function describeInput(input: unknown): string | null {
  if (typeof input === "string") return input.length > 0 ? input : null;
  if (typeof input !== "object" || input === null) return null;
  for (const key of ["command", "cmd", "script", "path", "file_path", "url"]) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  try {
    const json = JSON.stringify(input);
    return json === undefined || json === "{}" ? null : json;
  } catch {
    // A payload with a cycle in it is still a payload the operator is deciding
    // about; refusing to draw the card over it would be worse than no preview.
    return null;
  }
}

const styles = StyleSheet.create({
  card: { borderWidth: stroke.heavy, backgroundColor: ground.surface },
  head: { flexDirection: "row", alignItems: "center", gap: space.snug, paddingHorizontal: space.step, paddingVertical: space.snug },
  tool: { flex: 1, textAlign: "right" },
  body: { padding: space.step, gap: space.snug },
  input: { backgroundColor: ground.base, padding: space.snug, borderLeftWidth: stroke.hair, borderLeftColor: ground.edge },
  actions: { flexDirection: "row", gap: space.snug, padding: space.step, paddingTop: 0 },
  decision: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
  },
  refusal: { flexDirection: "row", alignItems: "center", gap: space.tight, padding: space.step, paddingTop: 0 },
});
