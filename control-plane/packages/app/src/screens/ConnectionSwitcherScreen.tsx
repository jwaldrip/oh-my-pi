/** Choose the daemon this device's Console is currently attached to. */

import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { ConnectionList, SavedConnection } from "../platform/connection.ts";

export function ConnectionSwitcherScreen({
  connections,
  onAdd,
  onBack,
  onSelect,
}: {
  connections: ConnectionList;
  onAdd: () => void;
  onBack: () => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <SafeScreen style={styles.screen} testID="connection-switcher">
      <View style={styles.heading}>
        <Kicker>Daemon</Kicker>
        <Display>Connections</Display>
        <Body>Choose where this device opens its console. Each pairing keeps its own credential.</Body>
      </View>
      <View style={styles.entries}>
        {connections.connections.map((entry) => (
          <ConnectionRow
            active={entry.id === connections.activeId}
            entry={entry}
            key={entry.id}
            onSelect={onSelect}
          />
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={onAdd} style={styles.add} testID="add-connection">
        <Text style={styles.addText}>Add connection</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back} testID="close-connection-switcher">
        <Text style={styles.backText}>Back to console</Text>
      </Pressable>
    </SafeScreen>
  );
}

function ConnectionRow({
  active,
  entry,
  onSelect,
}: {
  active: boolean;
  entry: SavedConnection;
  onSelect: (id: string) => void;
}): JSX.Element {
  const endpoint = entry.connection.transport === "direct" ? entry.connection.url : entry.connection.hubUrl;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => onSelect(entry.id)}
      style={[styles.entry, active && styles.entryActive]}
      testID={`connection-${entry.id}`}
    >
      <View style={styles.entryCopy}>
        <Label>{entry.label}</Label>
        <Text numberOfLines={1} style={styles.endpoint}>
          {endpoint}
        </Text>
      </View>
      <Text style={[styles.status, active ? styles.statusActive : styles.statusIdle]}>{active ? "Active" : "Saved"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, gap: space.loose, padding: space.wide },
  heading: { gap: space.snug },
  entries: { borderColor: ground.edge, borderTopWidth: stroke.hair },
  entry: {
    alignItems: "center",
    borderBottomColor: ground.line,
    borderBottomWidth: stroke.hair,
    flexDirection: "row",
    gap: space.step,
    minHeight: TOUCH_TARGET,
    paddingVertical: space.step,
  },
  entryActive: { backgroundColor: ground.active },
  entryCopy: { flex: 1, gap: space.tight },
  endpoint: { ...type.code, color: ink.muted },
  status: { ...type.label },
  statusActive: { color: signal.sage },
  statusIdle: { color: ink.muted },
  add: {
    alignItems: "center",
    backgroundColor: signal.sage,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  addText: { ...type.title, color: ink.inverse },
  back: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
  backText: { ...type.label, color: ink.plain },
});
