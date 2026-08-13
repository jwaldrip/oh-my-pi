/**
 * The position: the bay, a log, and the wiring between the socket and both.
 *
 * All of the decisions live in `state.ts`. This places them.
 *
 * The browser reducer is separate from the console reducer on purpose: the
 * console reducer answers to the socket and must stay byte-identical to what
 * a live daemon produces; the browser reducer answers to gestures (sort,
 * collapse, archive) that have nothing to do with the wire. `browserSessionsOf`
 * is the seam between them, and it is a temporary one -- see its doc comment.
 */

import type { JSX } from "react";
import { useEffect, useMemo, useReducer } from "react";
import { StyleSheet, View } from "react-native";
import { Toast } from "../components/Toast.tsx";
import { useSplitLayout } from "../design/layout.ts";
import { browserReduce, EMPTY_BROWSER } from "../session/browser.ts";
import { ground, stroke } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { FleetScreen } from "../screens/FleetScreen.tsx";
import { SessionScreen } from "../screens/SessionScreen.tsx";
import { browserSessionsOf, fleetClearances, sessionFor } from "./state.ts";
import { useConsole } from "./useConsole.ts";

export function Console({
  connection,
  onUnpair,
}: {
  connection: Connection;
  onUnpair: (notice?: string) => void;
}): JSX.Element {
  const [state, actions] = useConsole(connection);
  const split = useSplitLayout();
  const [browser, dispatchBrowser] = useReducer(browserReduce, EMPTY_BROWSER);

  useEffect(() => {
    if (state.unauthorized === null) return;
    onUnpair(`${state.unauthorized} Pair this device again to carry on.`);
  }, [state.unauthorized, onUnpair]);

  useEffect(() => {
    dispatchBrowser({ t: "load", sessions: browserSessionsOf(state) });
  }, [state]);

  const clearances = useMemo(() => fleetClearances(state), [state]);
  const agent = state.agents.find((candidate) => candidate.id === state.selected) ?? null;

  // Wide enough for both and nothing open is a hole rather than a choice, so
  // the top strip is taken. On a phone, opening a log is a deliberate act.
  useEffect(() => {
    if (!split || state.selected !== null) return;
    const top = state.agents[0];
    if (top !== undefined) actions.select(top.id);
  }, [split, state.selected, state.agents, actions]);

  const bay = (
    <FleetScreen
      browser={browser}
      onSort={(field) => {
        dispatchBrowser({ t: "sort", field });
      }}
      onToggleGroup={(cwd) => {
        dispatchBrowser({ t: "toggleGroup", cwd });
      }}
      onToggleGrouped={() => {
        dispatchBrowser({ t: "toggleGrouped" });
      }}
      onToggleArchived={() => {
        dispatchBrowser({ t: "toggleArchived" });
      }}
      onTakeover={(session) => {
        actions.select(session.id);
      }}
      onArchive={(session) => {
        dispatchBrowser({ t: "archive", id: session.id });
      }}
      onUnarchive={(session) => {
        dispatchBrowser({ t: "unarchive", id: session.id });
      }}
    />
  );

  const log =
    agent === null ? null : (
      <SessionScreen
        agent={agent}
        session={sessionFor(state, agent.id)}
        connection={state.connection}
        attempt={state.attempt}
        delayMs={state.delayMs}
        canApprove={state.canApprove}
        refusal={state.refusal}
        spoken={state.spoken.get(agent.id)?.text ?? null}
        fleetClearances={clearances}
        onBack={actions.back}
        onSubmit={(text) => {
          actions.prompt(agent.id, text);
        }}
        onCancel={() => {
          actions.cancel(agent.id);
        }}
        onDecide={(requestId, choice, scope) => {
          actions.decide(agent.id, requestId, choice, scope);
        }}
        onMountWebView={(target) => {
          actions.mountWebView(agent.id, target);
        }}
        onUnmountWebView={() => {
          actions.unmountWebView(agent.id);
        }}
      />
    );

  return (
    <View style={styles.position} testID="console">
      {split ? (
        <View style={styles.split}>
          <View style={styles.bay}>{bay}</View>
          <View style={styles.log}>{log}</View>
        </View>
      ) : (
        (log ?? bay)
      )}
      {state.notice === null ? null : <Toast message={state.notice} onDismiss={actions.dismiss} />}
    </View>
  );
}

const styles = StyleSheet.create({
  position: { flex: 1, backgroundColor: ground.base },
  split: { flex: 1, flexDirection: "row" },
  bay: { width: 340, borderRightWidth: stroke.heavy, borderRightColor: ground.edge },
  log: { flex: 1 },
});
