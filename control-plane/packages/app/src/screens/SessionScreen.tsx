/**
 * One agent's log, with its instruments under it.
 *
 * The header carries identity and state; the transcript carries the work; the
 * readout carries the two numbers that decide whether to keep going. Composer
 * last, because it is the only thing here a thumb reaches for.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { webViewCapability } from "../browser";
import type { WebViewTarget } from "../console/webview.ts";
import type { Agent, ApprovalChoice, ApprovalScope, PlanReviewChoice } from "@ompd/core/contracts";
import { Composer } from "../components/Composer.tsx";
import { PlanCard } from "../components/PlanCard.tsx";
import { StatusReadout } from "../components/StatusReadout.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
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
  onDecidePlan: (requestId: string, choice: PlanReviewChoice) => void;
  /**
   * Offer this screen's WebView as the agent's action target. Called when the
   * operator opens the browser pane and again after a remount; the daemon
   * keeps one target per agent, so re-offering is how a remount takes over.
   */
  onMountWebView?: (target: WebViewTarget) => void;
  /** Withdraw it. Always called when the pane closes or the screen unmounts. */
  onUnmountWebView?: () => void;
  now?: number;
}

export function SessionScreen(props: SessionScreenProps): JSX.Element {
  const { agent, session, connection } = props;
  const tone = signal[agentSignal(agent.state)];
  const busy = agent.state === "busy";
  const insets = useSafeAreaInsets();

  const [browserOpen, setBrowserOpen] = useState(false);
  const driver = useRef<WebViewTarget | null>(null);

  /**
   * The callbacks as of the last render, read rather than depended on.
   *
   * A parent that rebuilds these per render is the ordinary case: `Console`
   * closes over `agent.id`, and the log re-renders on every update frame of a
   * live turn. Depending on their identity would make the effect below
   * unregister and re-register on each of those, which is not merely noisy: in
   * the window between the two frames the daemon has no target for this agent,
   * so an action dispatched mid-turn fails with "no registered WebView" for a
   * pane that never went away.
   */
  const handlers = useRef({ onMountWebView: props.onMountWebView, onUnmountWebView: props.onUnmountWebView });
  useEffect(() => {
    handlers.current = { onMountWebView: props.onMountWebView, onUnmountWebView: props.onUnmountWebView };
  });

  /**
   * Registration follows the pane, and nothing else. An object ref rather than
   * a ref callback because React fills `.current` before effects run, so the
   * handle is already there, and the effect's dependencies can then be the two
   * facts that actually decide the registration: which agent, and whether its
   * browser is open.
   */
  useEffect(() => {
    if (!browserOpen) return;
    const handle = driver.current;
    if (handle === null) return;
    handlers.current.onMountWebView?.(handle);
    return () => {
      handlers.current.onUnmountWebView?.();
    };
  }, [browserOpen, agent.id]);

  return (
    <SafeScreen edges={{ top: true, bottom: false, left: true, right: true }} testID="session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="session-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain} testID="session-back-label">
            Sessions
          </Label>
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
            style={styles.iconHit}
          >
            <Glyph name="browser" size={14} color={browserOpen ? tone : ink.muted} />
          </Pressable>
        )}
      </View>

      <PlanCard
        canApprove={props.canApprove}
        onRespond={props.onDecidePlan}
        plan={session.plan}
        refusal={props.refusal}
        review={session.planReview}
      />

      <Transcript
        entries={session.entries}
        canApprove={props.canApprove}
        refusal={props.refusal}
        onDecide={props.onDecide}
        spoken={props.spoken}
      />

      {webViewCapability === null || !browserOpen ? null : (
        <View style={styles.browser} testID="session-browser">
          <webViewCapability.Driver ref={driver} style={styles.driver} />
        </View>
      )}

      <StatusReadout
        state={connection}
        attempt={props.attempt}
        delayMs={props.delayMs}
        usage={session.usage}
        clearances={props.fleetClearances}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/*
          Home-indicator inset lives on a child, not on KeyboardAvoidingView.
          KAV's padding behavior owns paddingBottom for the keyboard; putting
          the system inset on the same style loses it the moment the keyboard
          moves.
        */}
        <View style={{ paddingBottom: insets.bottom }} testID="session-composer-safe">
          <Composer
            enabled={connection === "connected"}
            busy={busy}
            onSubmit={props.onSubmit}
            onCancel={props.onCancel}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
  },
  // Labeled on purpose. An icon alone under a thumb is how an operator ends up
  // trapped in a session with no idea the bay is one tap away.
  back: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  iconHit: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: "center", justifyContent: "center" },
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
