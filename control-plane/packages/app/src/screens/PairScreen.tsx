/**
 * Where a device gets its credential.
 *
 * `notice` explains why the operator is looking at this screen again rather
 * than at their agents. A pairing form with no explanation, after a console
 * that was working a second ago, reads as the app having lost its mind.
 *
 * There is no prefilled endpoint. `ws://127.0.0.1` used to sit here as a
 * starting point, and on a phone loopback is the phone: it looked like an
 * answer and was never one. The daemon is the only thing that knows its own
 * address, so this screen asks for exactly what `ompd approve` prints rather
 * than guessing at it.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { parseEndpoint } from "@ompd/core/pairing";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import type { Connection } from "../platform/connection.ts";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";

export function PairScreen({
  notice,
  onCancel,
  onPair,
}: {
  notice?: string;
  onCancel?: () => void;
  onPair: (connection: Connection) => void;
}): JSX.Element {
  const [raw, setRaw] = useState("");
  const [token, setToken] = useState("");
  const { width } = useWindowDimensions();
  const endpoint = parseEndpoint(raw);
  const ready = endpoint !== null && token.trim().length > 0;

  return (
    <SafeScreen style={styles.screen} testID="pair">
      <View style={width > 480 ? [styles.form, { maxWidth: 480 }] : styles.form} testID="pair-form">
        <Kicker color={ink.muted}>ompd</Kicker>
        <Display heading>Take the position</Display>

        {notice === undefined ? null : (
          <View style={styles.notice} accessibilityLiveRegion="assertive" testID="pair-notice">
            <Glyph name="unpair" size={12} color={signal.ochre} />
            <Label color={signal.ochre} style={styles.noticeText}>
              {notice}
            </Label>
          </View>
        )}

        <Body color={ink.plain}>
          On the machine running the daemon: ompd pair for a code, then ompd approve that code. It prints
          a token and the endpoints this device can reach. Paste both here.
        </Body>

        <Field label="Daemon endpoint" value={raw} onChange={setRaw} testID="pair-endpoint" />
        {raw.trim().length === 0 ? null : (
          <Label color={endpoint === null ? signal.ochre : ink.muted} testID="pair-endpoint-kind">
            {endpoint === null
              ? "Not a daemon endpoint"
              : // A hub relay's base URL reads exactly like a direct socket's own
                // address, so without naming the transport back a paste from a
                // daemon behind NAT would look identical to one on the same
                // machine, and only fail once a phone actually tried it.
                endpoint.transport === "direct"
                ? "Direct socket"
                : `Hub relay, daemon ${endpoint.daemonId}`}
          </Label>
        )}
        <Field label="Device token" value={token} onChange={setToken} secure testID="pair-token" />

        <Pressable
          testID="pair-submit"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => {
            if (endpoint === null) return;
            const trimmedToken = token.trim();
            onPair(
              endpoint.transport === "direct"
                ? { transport: "direct", url: endpoint.url, token: trimmedToken, scopes: [] }
                : { transport: "hub", hubUrl: endpoint.hubUrl, daemonId: endpoint.daemonId, token: trimmedToken, scopes: [] },
            );
          }}
          style={({ pressed }) => [
            styles.submit,
            { borderColor: ready ? signal.sage : ground.edge },
            pressed && { backgroundColor: ground.active },
          ]}
        >
          <Label color={ready ? signal.sage : ink.faint}>Connect</Label>
        </Pressable>
        {onCancel === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel} testID="pair-cancel">
            <Label color={ink.plain}>Back to connections</Label>
          </Pressable>
        )}
      </View>
    </SafeScreen>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  testID,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  secure?: boolean;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.field}>
      <Kicker color={ink.muted}>{label}</Kicker>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        style={[styles.input, type.code]}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure === true}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { justifyContent: "center", padding: space.loose },
  form: { gap: space.step, width: "100%", alignSelf: "center" },
  notice: {
    flexDirection: "row",
    gap: space.snug,
    padding: space.step,
    backgroundColor: signalWash.ochre,
    borderLeftWidth: stroke.heavy,
    borderLeftColor: signal.ochre,
  },
  noticeText: { flex: 1 },
  field: { gap: space.tight },
  input: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  submit: {
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hair,
    marginTop: space.snug,
  },
  cancel: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
});
