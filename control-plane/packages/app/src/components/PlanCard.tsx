/**
 * The operator's checkpoint between planning and execution.
 *
 * A plan update can arrive just before ACP asks for its answer, so the card
 * becomes visible for either fact. Its controls stay disabled until the
 * elicitation supplies a request id: a button that looks live but cannot reach
 * ACP would teach an operator that their decision landed when it did not.
 */

import { useState, type JSX } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { PlanReviewChoice } from "@ompd/core/contracts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { PlanEntry, PlanReview } from "../session/model.ts";

export interface PlanCardProps {
  plan: readonly PlanEntry[];
  review: PlanReview | null;
  canApprove: boolean;
  refusal?: string;
  onRespond: (requestId: string, choice: PlanReviewChoice, feedback?: string) => void;
}

export function PlanCard({ plan, review, canApprove, refusal, onRespond }: PlanCardProps): JSX.Element | null {
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState("");
  const hasPendingPlan = review !== null || plan.some((entry) => entry.status === "pending");
  if (!hasPendingPlan) return null;

  const canRespond = review !== null && canApprove;
  const respond = (choice: PlanReviewChoice, note?: string): void => {
    if (review === null) return;
    onRespond(review.requestId, choice, note);
  };

  return (
    <View style={styles.card} testID="plan-review">
      <View style={styles.head}>
        <Kicker color={signal.ochre}>plan review</Kicker>
        <Label color={ink.muted}>{review === null ? "waiting for plan details" : "approval required"}</Label>
      </View>
      {review === null ? null : <Body style={styles.message}>{review.message}</Body>}
      {plan.length === 0 ? null : (
        <View style={styles.steps}>
          {plan.map((entry, index) => (
            <Label color={entry.status === "completed" ? ink.muted : ink.plain} key={`${index}-${entry.content}`}>
              {entry.status === "completed" ? "Done" : "Plan"}  {entry.content}
            </Label>
          ))}
        </View>
      )}
      {refining ? (
        <View style={styles.feedback}>
          <TextInput
            accessibilityLabel="Plan feedback"
            autoFocus
            multiline
            onChangeText={setFeedback}
            placeholder="What should change?"
            placeholderTextColor={ink.faint}
            style={styles.input}
            testID="plan-feedback"
            value={feedback}
          />
          <View style={styles.actions}>
            <Decision
              disabled={!canRespond}
              label="Send feedback"
              onPress={() => {
                respond("Refine plan", feedback.trim() || undefined);
              }}
              testID="plan-send-feedback"
              tone={signal.ochre}
            />
            <Decision
              disabled={false}
              label="Cancel"
              onPress={() => {
                setRefining(false);
              }}
              testID="plan-cancel-refine"
              tone={ink.muted}
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Decision
            disabled={!canRespond}
            label="Approve and execute"
            onPress={() => {
              respond("Approve and execute");
            }}
            testID="plan-approve"
            tone={signal.sage}
          />
          <Decision
            disabled={!canRespond}
            label="Refine plan"
            onPress={() => {
              setRefining(true);
            }}
            testID="plan-refine"
            tone={signal.ochre}
          />
        </View>
      )}
      {!canApprove ? <Label color={ink.muted}>{refusal ?? "This device does not hold the approve scope."}</Label> : null}
    </View>
  );
}

function Decision({
  disabled,
  label,
  onPress,
  testID,
  tone,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  testID: string;
  tone: string;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.decision, { borderColor: tone }, disabled && styles.disabled, pressed && styles.pressed]}
      testID={testID}
    >
      <Label color={disabled ? ink.faint : tone}>{label}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderColor: signal.ochre,
    borderRadius: 8,
    borderWidth: stroke.heavy,
    gap: space.snug,
    marginHorizontal: space.wide,
    marginTop: space.snug,
    padding: space.wide,
  },
  head: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  message: { color: ink.plain },
  steps: { borderLeftColor: ground.edge, borderLeftWidth: stroke.hair, gap: space.tight, paddingLeft: space.snug },
  actions: { flexDirection: "row", gap: space.snug },
  decision: {
    alignItems: "center",
    borderRadius: 6,
    borderWidth: stroke.hair,
    flex: 1,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
  },
  feedback: { gap: space.snug },
  input: {
    borderColor: ground.edge,
    borderRadius: 6,
    borderWidth: stroke.hair,
    color: ink.plain,
    minHeight: 88,
    padding: space.snug,
    textAlignVertical: "top",
  },
  disabled: { borderColor: ground.edge, opacity: 0.65 },
  pressed: { backgroundColor: ground.active },
});
