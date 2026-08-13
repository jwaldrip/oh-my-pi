/**
 * The two things an operator has to be able to see without asking: whether the
 * link is up, and what this session is costing.
 *
 * Connection state gets a filled bar rather than a dot, because a dot the size
 * of a full stop is not a status indicator on a phone held at arm's length. The
 * reconnect countdown is printed rather than animated: "retrying in 4s" is a
 * fact, and a spinner is a promise the app cannot keep.
 */

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { formatMoney, formatTokens } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label } from "../design/text.tsx";
import type { SignalName } from "../design/tokens.ts";
import { ground, ink, pressureSignal, signal, signalWash, space, stroke } from "../design/tokens.ts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { Usage } from "../session/model.ts";

/** What each connection state means, in the words shown on screen. */
const LINK_WORDS: Record<ConnectionState, string> = {
  connecting: "connecting",
  connected: "linked",
  reconnecting: "retrying",
  offline: "no link",
};

const LINK_SIGNALS: Record<ConnectionState, SignalName> = {
  connecting: "ochre",
  connected: "sage",
  reconnecting: "ochre",
  offline: "oxide",
};

export interface StatusReadoutProps {
  state: ConnectionState;
  /** Consecutive failed attempts. Printed once it stops being zero. */
  attempt: number;
  /** Milliseconds until the next attempt, when one is scheduled. */
  delayMs?: number;
  usage: Usage | null;
  /** Pending clearances across the whole fleet, not just the open session. */
  clearances: number;
}

export function StatusReadout({ state, attempt, delayMs, usage, clearances }: StatusReadoutProps): JSX.Element {
  const tone = signal[LINK_SIGNALS[state]];
  const wash = signalWash[LINK_SIGNALS[state]];
  const fraction = usage === null || usage.size === 0 ? null : usage.used / usage.size;
  const pressure = fraction === null ? ink.faint : signal[pressureSignal(fraction)];

  return (
    <View style={styles.readout} testID="status-readout">
      <View style={[styles.link, { backgroundColor: wash, borderColor: tone }]}>
        <Glyph name="link" size={11} color={tone} />
        <Kicker color={tone} testID="status-link">
          {LINK_WORDS[state]}
        </Kicker>
        {state === "reconnecting" && delayMs !== undefined ? (
          <Data color={ink.muted} testID="status-retry">{`${Math.max(1, Math.round(delayMs / 1000))}s`}</Data>
        ) : null}
        {attempt > 0 && state !== "connected" ? (
          <Data color={ink.faint} testID="status-attempt">{`#${attempt}`}</Data>
        ) : null}
      </View>

      <View style={styles.meters}>
        <Meter
          glyph="load"
          label="context"
          tone={pressure}
          testID="status-context"
          value={
            usage === null || usage.size === 0
              ? "--"
              : `${formatTokens(usage.used)}/${formatTokens(usage.size)}`
          }
        />
        <Meter
          glyph="cost"
          label="spend"
          tone={ink.bright}
          testID="status-spend"
          value={usage === null ? "--" : formatMoney(usage.costAmount, usage.costCurrency)}
        />
        {clearances > 0 ? (
          <Meter
            glyph="clearance"
            label="holding"
            tone={signal.ochre}
            testID="status-clearances"
            value={String(clearances)}
          />
        ) : null}
      </View>
    </View>
  );
}

function Meter({
  glyph,
  label,
  value,
  tone,
  testID,
}: {
  glyph: "load" | "cost" | "clearance";
  label: string;
  value: string;
  tone: string;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Glyph name={glyph} size={10} color={ink.faint} />
        <Label color={ink.faint}>{label}</Label>
      </View>
      <Data color={tone} testID={testID}>
        {value}
      </Data>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.wide,
    paddingHorizontal: space.wide,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    paddingVertical: space.tight,
    borderLeftWidth: stroke.heavy,
  },
  meters: { flexDirection: "row", gap: space.loose },
  meter: { gap: space.hair },
  meterHead: { flexDirection: "row", alignItems: "center", gap: space.tight },
});
