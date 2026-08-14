/**
 * The whole app: pair, or take the position.
 *
 * There is no router. Two screens and one selection do not need one, and a
 * navigation library is a second source of truth about which agent is open.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Console } from "./console/Console.tsx";
import { SafeScreen } from "./design/SafeScreen.tsx";
import { ink } from "./design/tokens.ts";
import type { Connection } from "./platform/connection.ts";
import { clearConnection, loadConnection, saveConnection } from "./platform/connection.ts";
import { listenForCollabLinks, type DeepLinkSource } from "./platform/deeplink.ts";
import { CollabSessionScreen } from "./screens/CollabSessionScreen.tsx";
import { PairScreen } from "./screens/PairScreen.tsx";

type Boot = { phase: "loading" } | { phase: "pair"; notice?: string } | { phase: "console"; connection: Connection };

const nativeDeepLinks: DeepLinkSource = {
  getInitialURL: () => Linking.getInitialURL(),
  addEventListener: (event, listener) => Linking.addEventListener(event, listener),
};

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [collabRoomId, setCollabRoomId] = useState<string | null>(null);

  useEffect(() => listenForCollabLinks(nativeDeepLinks, setCollabRoomId), []);


  useEffect(() => {
    let cancelled = false;
    void loadConnection()
      .then((connection) => {
        if (cancelled) return;
        setBoot(connection === null ? { phase: "pair" } : { phase: "console", connection });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setBoot({ phase: "pair", notice: describe(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The store is written before the console opens, not alongside it. A pairing
   * that only lives in React state is lost on the next cold start, which is
   * how a phone ends up looking unpaired after a restart that did nothing wrong.
   */
  const pair = useCallback(async (connection: Connection) => {
    await saveConnection(connection);
    setBoot({ phase: "console", connection });
  }, []);

  /**
   * The daemon has confirmed the token is dead. Keeping it would leave the app
   * reconnecting forever on a credential that will never work again.
   */
  const unpair = useCallback(async (notice?: string) => {
    await clearConnection();
    setBoot({ phase: "pair", notice });
  }, []);

  let body: JSX.Element;
  if (boot.phase === "loading") {
    body = (
      <SafeScreen style={styles.boot} testID="boot">
        <ActivityIndicator color={ink.plain} />
      </SafeScreen>
    );
  } else if (collabRoomId !== null && boot.phase === "console") {
    body = (
      <CollabSessionScreen roomId={collabRoomId} connection={boot.connection} onClose={() => setCollabRoomId(null)} />
    );
  } else if (boot.phase === "pair") {
    body = (
      <PairScreen
        notice={collabRoomId === null ? boot.notice : "Pair this device to join the shared room."}
        onPair={pair}
      />
    );
  } else {
    // Keyed on the durable halves of the connection so a re-pair with a new
    // daemon rebuilds the console rather than leaving the old socket open.
    const key =
      boot.connection.transport === "direct"
        ? `${boot.connection.url}:${boot.connection.token.length}`
        : `${boot.connection.hubUrl}:${boot.connection.daemonId}:${boot.connection.token.length}`;
    body = <Console key={key} connection={boot.connection} onUnpair={unpair} />;
  }

  return <SafeAreaProvider>{body}</SafeAreaProvider>;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  boot: { alignItems: "center", justifyContent: "center" },
});
