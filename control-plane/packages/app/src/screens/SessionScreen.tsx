/**
 * One agent's log, with its instruments under it.
 *
 * The header carries identity and state; the transcript carries the work; the
 * readout carries the two numbers that decide whether to keep going. Composer
 * last, because it is the only thing here a thumb reaches for.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { webViewCapability } from "../browser/index.ts";
import type { WebViewDriverHandle } from "../browser/index.ts";
import type { Agent, ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { Composer } from "../components/Composer.tsx";
import { StatusReadout } from "../components/StatusReadout.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { agentSignal, ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { SessionState } from "../session/model.ts";

export interface SessionScreenProps {
  agent: Agent;
  session: SessionState;
  connection: ConnectionState;
  attempt: number;
  delayMs?: number;
  canApprove: boolean;
  refusal?: string;
  /** The daemon's prose for the last settled turn, if it sent one. */
  spoken: string | null;
  /** Pending clearances across the fleet, so the readout is not agent-local. */
  fleetClearances: number;
  onBack: () => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  /**
   * Offer this screen's WebView as the agent's action target. Called when the
   * operator opens the browser pane and again after a remount; the daemon
   * keeps one target per agent, so re-offering is how a remount takes over.
   */
  onMountWebView?: (target: WebViewDriverHandle) => void;
  /** Withdraw it. Always called when the pane closes or the screen unmounts. */
  onUnmountWebView?: () => void;
  now?: number;
}

export function SessionScreen(props: SessionScreenProps): JSX.Element {
  const { agent, session, connection } = props;
  const tone = signal[agentSignal(agent.state)];
  const busy = agent.state === "busy";

  const { onMountWebView, onUnmountWebView } = props;
  const [browserOpen, setBrowserOpen] = useState(false);
  const mounted = useRef(false);

  /**
   * The ref callback is the mount signal, not an effect: the handle exists
   * only once the driver has rendered, and registering before that would
   * offer the daemon a target that cannot yet answer an action.
   */
  const holdDriver = useCallback(
    (handle: WebViewDriverHandle | null) => {
      if (handle === null) {
        if (!mounted.current) return;
        mounted.current = false;
        onUnmountWebView?.();
        return;
      }
      mounted.current = true;
      onMountWebView?.(handle);
    },
    [onMountWebView, onUnmountWebView],
  );

  // Leaving the screen with the pane open never leaves a registration behind:
  // the daemon would keep dispatching to a view that no longer exists, and
  // every action would wait out its full timeout before failing.
  useEffect(
    () => () => {
      if (!mounted.current) return;
      mounted.current = false;
      onUnmountWebView?.();
    },
    [onUnmountWebView],
  );

  return (
    <View style={styles.screen} testID="session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="session-back"
          accessibilityRole="button"
          accessibilityLabel="Back to the bay"
          onPress={props.onBack}
          style={styles.back}
        >
          <Glyph name="back" size={14} color={ink.plain} />
        </Pressable>

        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="session-name">
            {agent.name}
          </Title>
          <View style={styles.meta}>
            <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
              {shortenPath(agent.cwd, 3)}
            </Label>
            <Data color={ink.faint}>{elapsed(agent.lastActiveAt, props.now)}</Data>
          </View>
        </View>

        <Kicker color={tone} testID="session-state">
          {agent.state}
        </Kicker>

        {webViewCapability === null ? null : (
          <Pressable
            testID="session-browser-toggle"
            accessibilityRole="button"
            accessibilityLabel={browserOpen ? "Close the agent's browser" : "Open the agent's browser"}
            accessibilityState={{ selected: browserOpen }}
            onPress={() => {
              setBrowserOpen((open) => !open);
            }}
            style={styles.back}
          >
            <Glyph name="browser" size={14} color={browserOpen ? tone : ink.muted} />
          </Pressable>
        )}
      </View>

      <Transcript
        entries={session.entries}
        canApprove={props.canApprove}
        refusal={props.refusal}
        onDecide={props.onDecide}
        spoken={props.spoken}
      />

      {webViewCapability === null || !browserOpen ? null : (
        <View style={styles.browser} testID="session-browser">
          <webViewCapability.Driver ref={holdDriver} style={styles.driver} />
        </View>
      )}

      <StatusReadout
        state={connection}
        attempt={props.attempt}
        delayMs={props.delayMs}
        usage={session.usage}
        clearances={props.fleetClearances}
      />

      <Composer
        enabled={connection === "connected"}
        busy={busy}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ground.base },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
  },
  back: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: "center", justifyContent: "center" },
  ident: { flex: 1, gap: space.hair },
  meta: { flexDirection: "row", alignItems: "center", gap: space.snug },
  origin: { flexShrink: 1 },
  browser: {
    height: 320,
    borderTopWidth: stroke.heavy,
    borderTopColor: ground.edge,
    backgroundColor: ground.surface,
  },
  driver: { flex: 1 },
});
