/**
 * The whole app: pair, choose a saved daemon, or take the position.
 *
 * There is no router. The boot state is the one source of truth for whether
 * the operator is pairing, changing daemon, or working in a Console.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Console } from "./console/Console.tsx";
import { SafeScreen } from "./design/SafeScreen.tsx";
import { ground, ink, stroke, type } from "./design/tokens.ts";
import type { Connection, ConnectionList } from "./platform/connection.ts";
import { clearConnection, loadConnections, saveConnection, setActiveConnection } from "./platform/connection.ts";
import { ConnectionSwitcherScreen } from "./screens/ConnectionSwitcherScreen.tsx";
import { PairScreen } from "./screens/PairScreen.tsx";

type Boot =
  | { phase: "loading" }
  | { phase: "pair"; notice?: string; returnToSwitcher?: ConnectionList }
  | { phase: "switch"; connections: ConnectionList }
  | { phase: "console"; connections: ConnectionList };

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  const showConnections = useCallback((connections: ConnectionList, notice?: string) => {
    const active = connections.connections.find((entry) => entry.id === connections.activeId);
    setBoot(active === undefined ? { phase: "pair", notice } : { phase: "console", connections });
  }, []);

  const reloadConnections = useCallback(async (notice?: string) => {
    showConnections(await loadConnections(), notice);
  }, [showConnections]);

  useEffect(() => {
    let cancelled = false;
    void loadConnections()
      .then((connections) => {
        if (!cancelled) showConnections(connections);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBoot({ phase: "pair", notice: describe(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [showConnections]);

  /** The store is written before the Console opens, never only into React state. */
  const pair = useCallback(async (connection: Connection) => {
    await saveConnection(connection);
    await reloadConnections();
  }, [reloadConnections]);

  const activate = useCallback(async (id: string) => {
    await setActiveConnection(id);
    await reloadConnections();
  }, [reloadConnections]);

  /** A rejected token removes only its own pairing, preserving every other daemon. */
  const unpair = useCallback(async (id: string, notice?: string) => {
    await clearConnection(id);
    await reloadConnections(notice);
  }, [reloadConnections]);

  let body: JSX.Element;
  if (boot.phase === "loading") {
    body = (
      <SafeScreen style={styles.boot} testID="boot">
        <ActivityIndicator color={ink.plain} />
      </SafeScreen>
    );
  } else if (boot.phase === "pair") {
    body = (
      <PairScreen
        notice={boot.notice}
        onCancel={
          boot.returnToSwitcher === undefined ? undefined : () => setBoot({ phase: "switch", connections: boot.returnToSwitcher! })
        }
        onPair={pair}
      />
    );
  } else if (boot.phase === "switch") {
    body = (
      <ConnectionSwitcherScreen
        connections={boot.connections}
        onAdd={() => setBoot({ phase: "pair", returnToSwitcher: boot.connections })}
        onBack={() => showConnections(boot.connections)}
        onSelect={activate}
      />
    );
  } else {
    const active = boot.connections.connections.find((entry) => entry.id === boot.connections.activeId);
    if (active === undefined) {
      body = <PairScreen onPair={pair} />;
    } else {
      const key =
        active.connection.transport === "direct"
          ? `${active.id}:${active.connection.url}:${active.connection.token.length}`
          : `${active.id}:${active.connection.hubUrl}:${active.connection.daemonId}:${active.connection.token.length}`;
      body = (
        <View style={styles.consoleShell}>
          <Console
            key={key}
            connection={active.connection}
            onUnpair={(notice) => {
              void unpair(active.id, notice);
            }}
          />
          <SafeAreaView edges={["bottom"]} style={styles.switcherSafe}>
            <Pressable
              accessibilityLabel="Switch connections"
              onPress={() => setBoot({ phase: "switch", connections: boot.connections })}
              style={styles.switcher}
              testID="open-connection-switcher"
            >
              <Text style={styles.switcherText}>Connections</Text>
            </Pressable>
          </SafeAreaView>
        </View>
      );
    }
  }

  return <SafeAreaProvider>{body}</SafeAreaProvider>;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  boot: { alignItems: "center", justifyContent: "center" },
  consoleShell: { flex: 1 },
  switcherSafe: { backgroundColor: ground.raised, borderColor: ground.edge, borderTopWidth: stroke.hair },
  switcher: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  switcherText: { ...type.label, color: ink.bright },
});
