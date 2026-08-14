/**
 * One connector, as a row.
 *
 * A connector list that cannot say why something is broken is decoration: the
 * reason sits directly under the name, at the failure colour, at the same
 * weight as the status word — not a tooltip, not a second tap away. It is
 * also the one place in this surface where a raw string from the daemon could
 * leak a credential; `connectorReason` is the backstop that keeps that from
 * ever rendering (see `cowork/catalog.ts`).
 */

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { CONNECTOR_STATUS_LABELS, CONNECTOR_STATUS_SIGNALS, connectorReason, deriveOrigin } from "../cowork/catalog.ts";
import type { ConnectorSummary } from "../cowork/types.ts";
import { Glyph } from "../design/icons.tsx";
import { Body, Kicker, Title } from "../design/text.tsx";
import { ground, signal, space, stroke } from "../design/tokens.ts";
import { PluginBadge } from "./PluginBadge.tsx";

export function ConnectorRow({ connector }: { connector: ConnectorSummary }): JSX.Element {
  const tone = signal[CONNECTOR_STATUS_SIGNALS[connector.status]];
  const down = connector.status !== "connected";
  const groupLabel = connector.pluginName ?? connector.providerName ?? connector.name;
  const origin = deriveOrigin(connector.providerName);

  return (
    <View style={styles.row} testID={`connector-${connector.name}`}>
      <View style={[styles.bar, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <View style={styles.headline}>
          <Title numberOfLines={1} style={styles.name}>
            {connector.name}
          </Title>
          <Kicker color={tone} testID={`connector-${connector.name}-status`}>
            {CONNECTOR_STATUS_LABELS[connector.status]}
          </Kicker>
        </View>

        {down ? (
          <View style={styles.reason}>
            <Glyph name="warning" size={11} color={tone} />
            <Body color={tone} numberOfLines={3} testID={`connector-${connector.name}-reason`} style={styles.reasonText}>
              {connectorReason(connector)}
            </Body>
          </View>
        ) : null}

        <PluginBadge origin={origin} label={groupLabel} testID={`connector-${connector.name}-origin`} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  bar: { width: 3 },
  body: { flex: 1, padding: space.step, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  name: { flexShrink: 1 },
  reason: { flexDirection: "row", alignItems: "flex-start", gap: space.tight },
  reasonText: { flex: 1 },
});
