/**
 * The running log for one agent.
 *
 * A `FlatList` rather than a mapped `ScrollView`, because a long session runs to
 * thousands of entries and every one of them stays mounted in the naive form.
 * The reducer already gives each entry a stable id and shares by reference for
 * anything that did not change, so the list's own row memoisation actually
 * holds and a streaming token repaints one row.
 *
 * Speaker attribution is a left gutter rather than a bubble. Chat bubbles put
 * the message on alternating sides, which halves the usable width on a phone
 * and buys nothing here: there are only ever two speakers and one of them is
 * the person holding the device.
 */

import type { JSX } from "react";
import { useCallback } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";
import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { Glyph } from "../design/icons.tsx";
import { Body, Code, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import type { Entry } from "../session/model.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ToolCard } from "./ToolCard.tsx";

export interface TranscriptProps {
  entries: readonly Entry[];
  canApprove: boolean;
  /** Why approval is refused, when the daemon has said so. */
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  /** The daemon's prose summary of the last settled turn, when there is one. */
  spoken?: string | null;
}

export function Transcript({ entries, canApprove, refusal, onDecide, spoken }: TranscriptProps): JSX.Element {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Entry>) => (
      <EntryRow entry={item} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
    ),
    [canApprove, refusal, onDecide],
  );

  return (
    <FlatList
      testID="transcript"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={entries as Entry[]}
      keyExtractor={(entry) => `${entry.kind}:${entry.id}`}
      renderItem={renderItem}
      ListFooterComponent={
        spoken === null || spoken === undefined || spoken.length === 0 ? null : <Spoken text={spoken} />
      }
      ListEmptyComponent={<Empty />}
    />
  );
}

function EntryRow({
  entry,
  canApprove,
  refusal,
  onDecide,
}: {
  entry: Entry;
  canApprove: boolean;
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
}): JSX.Element {
  switch (entry.kind) {
    case "user":
      return (
        <View
          style={styles.row}
          testID={`entry-user-${entry.id}`}
          // XCUITest finds rows by identifier and reads the prompt from the
          // accessibility label. Without this, a nested Body Text is often
          // invisible to the query tree even though it is on screen.
          accessible
          accessibilityLabel={`you: ${entry.text}`}
        >
          <View style={[styles.gutter, { borderLeftColor: ink.faint }]}>
            <Kicker color={ink.muted}>you</Kicker>
          </View>
          <Body style={styles.prose}>{entry.text}</Body>
        </View>
      );

    case "assistant":
      return (
        <View
          style={styles.row}
          testID={`entry-assistant-${entry.id}`}
          accessible
          accessibilityLabel={`${entry.thought ? "thinking" : "agent"}: ${entry.text}`}
        >
          <View style={[styles.gutter, { borderLeftColor: entry.thought ? signal.violet : signal.sage }]}>
            <Kicker color={entry.thought ? signal.violet : signal.sage}>
              {entry.thought ? "thinking" : "agent"}
            </Kicker>
            {entry.streaming ? <Glyph name="activity" size={9} color={signal.amber} /> : null}
          </View>
          <Body color={entry.thought ? ink.plain : ink.bright} style={styles.prose}>
            {entry.text}
          </Body>
        </View>
      );

    case "tool":
      return (
        <View style={styles.cardRow}>
          <ToolCard entry={entry} />
        </View>
      );

    case "approval":
      return (
        <View style={styles.cardRow}>
          <ApprovalCard entry={entry} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
        </View>
      );

    default:
      // A payload this build has never seen. An operator watching an agent run
      // is owed the truth that something happened, even unnamed.
      return (
        <View style={styles.row} testID={`entry-unknown-${entry.id}`}>
          <View style={[styles.gutter, { borderLeftColor: ground.edge }]}>
            <Glyph name="unknown" size={11} color={ink.faint} />
          </View>
          <View style={styles.prose}>
            <Label color={ink.muted}>{entry.label}</Label>
          </View>
        </View>
      );
  }
}

/**
 * What the daemon would say out loud. Shown as text because this build has no
 * voice of its own yet, and a summary that only exists as audio nobody plays is
 * a summary that was never delivered.
 */
function Spoken({ text }: { text: string }): JSX.Element {
  return (
    <View style={styles.spoken} testID="transcript-say">
      <Glyph name="link" size={11} color={signal.violet} />
      <Code color={ink.plain} style={styles.spokenText}>
        {text}
      </Code>
    </View>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="transcript-empty">
      <Glyph name="bay" size={22} color={ground.edge} />
      <Label color={ink.muted}>Nothing on this strip yet.</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: ground.base },
  content: { padding: space.wide, gap: space.step },
  row: { flexDirection: "row", gap: space.step },
  gutter: {
    width: 76,
    borderLeftWidth: stroke.heavy,
    paddingLeft: space.snug,
    gap: space.tight,
    alignItems: "flex-start",
  },
  prose: { flex: 1 },
  cardRow: { marginVertical: space.tight },
  spoken: {
    flexDirection: "row",
    gap: space.snug,
    padding: space.step,
    marginTop: space.snug,
    backgroundColor: ground.surface,
    borderLeftWidth: stroke.heavy,
    borderLeftColor: signal.violet,
  },
  spokenText: { flex: 1 },
  empty: { alignItems: "center", gap: space.step, paddingVertical: space.gulf },
});
