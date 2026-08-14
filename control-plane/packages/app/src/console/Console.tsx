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
import { useEffect, useMemo, useReducer, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { AgentHub } from "../components/AgentHub.tsx";
import { Toast } from "../components/Toast.tsx";
import { useSplitLayout } from "../design/layout.ts";
import { browserReduce, EMPTY_BROWSER } from "../session/browser.ts";
import { ground, stroke } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { FleetScreen } from "../screens/FleetScreen.tsx";
import { SessionScreen } from "../screens/SessionScreen.tsx";
import { browserSessionsOf, fleetClearances, sessionFor } from "./state.ts";
import { useConsole } from "./useConsole.ts";
import { useHardwareBack } from "./useHardwareBack.ts";
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
  // the top strip is taken once. Only once: an operator who backed out of a
  // session on a tablet is not asking the bay to immediately reopen the same
  // log. Phones never hit this path because `split` is false there.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (!split || state.selected !== null || didAutoSelect.current) return;
    const top = state.agents.find((candidate) => candidate.parentAgentId === undefined);
    if (top === undefined) return;
    didAutoSelect.current = true;
    actions.select(top.id);
  }, [split, state.selected, state.agents, actions]);

  // Android hardware back is the system way back to the bay on a phone. On a
  // split layout the bay is already on screen, so claiming back would steal the
  // OS gesture for no gain.
  useHardwareBack(!split && state.selected !== null, actions.back);

  const bay = (
    <View style={split ? styles.splitBay : styles.bay}>
      <AgentHub agents={state.agents} />
      <View style={styles.fleet}>
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
      </View>
    </View>
  );

  const log =
    agent === null ? null : (
      // Keyed, so selecting a different agent builds a new screen rather than
      // re-rendering this one with different props. The browser pane is an
      // offer the operator made about one agent: carried across a selection it
      // would leave a page from the previous agent's work open, registered as
      // the new agent's target, without anyone having asked for it.
      <SessionScreen
        key={agent.id}
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
  bay: { flex: 1 },
  splitBay: { width: 340, borderRightWidth: stroke.heavy, borderRightColor: ground.edge },
  fleet: { flex: 1 },
  log: { flex: 1 },
});
