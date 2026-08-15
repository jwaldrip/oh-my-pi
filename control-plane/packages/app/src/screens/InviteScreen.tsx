/**
 * Mint a second device's credential and hand it over as a QR code.
 *
 * This screen is the app playing the role `ompd approve` plays on the
 * daemon's own machine: it spends this device's own `approve` scope to grant
 * a new device a token, then shows that token as a code the new device scans
 * -- never as a link. `core/src/pairing.ts` explains why a `PairingBundle`
 * carrying a bearer token must never become a URL; this screen is the other
 * half of that contract, the one that mints the bundle in the first place.
 *
 * The two-request shape mirrors the CLI's `pair` then `approve`: `POST
 * /v1/pair` is unauthenticated and only records an intent, so it grants
 * nothing by itself. `POST /v1/pairings/approve` is the deliberate act that
 * spends this device's own scopes, which is why the scope picker below
 * starts at this device's own scopes rather than at every scope that
 * exists -- widening past them is still possible, because the operator may
 * legitimately want a narrower or, having thought about it, a broader grant,
 * but the daemon is the one that enforces the ceiling, not this screen.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ } from "@ompd/core/contracts";
import { encodePairingBundle } from "@ompd/core/pairing";
import type { PairedConnection } from "@ompd/core/pairing";
import { restRoot } from "../cowork/useCowork.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

/** Every scope the daemon knows how to grant. Mirrors the gateway's own `KNOWN_SCOPES`, which is not exported. */
const ALL_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_APPROVE, SCOPE_MANAGE];

type Status =
  | { kind: "pending" }
  | { kind: "minting" }
  | { kind: "ready"; encoded: string; label: string }
  | { kind: "error"; message: string };

interface PairResponse {
  code: string;
}

interface ApproveResponse {
  token: string;
  name: string;
}


export function InviteScreen({ connection, onDone }: { connection: Connection; onDone: () => void }): JSX.Element {
  const [name, setName] = useState("New device");
  const [scopes, setScopes] = useState<Set<string>>(() => new Set(connection.scopes));
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  // A hub connection is a relay for the socket protocol only; there is no
  // HTTP surface behind it to hang `/v1/pair` on, the same gap `useCowork`'s
  // `authFetch` already fails closed on rather than guessing at a root.
  const root = connection.transport === "direct" ? restRoot(connection.url) : null;

  const mint = useCallback(async () => {
    if (root === null) {
      setStatus({ kind: "error", message: "This connection has no reachable HTTP endpoint to invite a device from." });
      return;
    }
    setStatus({ kind: "minting" });
    try {
      const pairRes = await fetch(`${root}/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A throwaway provenance string, the same convention `ompd pair`'s CLI
        // counterpart uses -- not real cryptography; see `platform/connection.ts`
        // for why a saved connection's token is what actually carries authority.
        body: JSON.stringify({ name, publicKey: `app:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }),
      });
      if (!pairRes.ok) throw new Error(`could not start pairing: ${pairRes.status}`);
      const { code } = (await pairRes.json()) as PairResponse;

      const approveRes = await fetch(`${root}/v1/pairings/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ code, scopes: [...scopes] }),
      });
      if (!approveRes.ok) {
        const body: unknown = await approveRes.json().catch(() => null);
        const errorCode = typeof body === "object" && body !== null ? Reflect.get(body, "error") : undefined;
        if (approveRes.status === 403 && errorCode === "scope_escalation") {
          const missing = typeof body === "object" && body !== null ? Reflect.get(body, "missing") : undefined;
          const missingList = Array.isArray(missing) ? missing.join(", ") : "one or more scopes";
          setStatus({
            kind: "error",
            message: `This device cannot grant ${missingList}: it doesn't hold that scope itself.`,
          });
          return;
        }
        throw new Error(`could not approve pairing: ${approveRes.status}`);
      }
      const { token, name: grantedName } = (await approveRes.json()) as ApproveResponse;

      const paired: PairedConnection =
        connection.transport === "direct"
          ? { transport: "direct", url: connection.url, token, scopes: [...scopes] }
          : { transport: "hub", hubUrl: connection.hubUrl, daemonId: connection.daemonId, token, scopes: [...scopes] };
      const encoded = encodePairingBundle({ v: 1, label: grantedName, connection: paired });
      setStatus({ kind: "ready", encoded, label: grantedName });
    } catch (cause) {
      setStatus({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [connection, name, root, scopes]);

  useEffect(() => {
    void mint();
    // Minted once on mount with this device's own scopes; re-minting is an
    // explicit re-press of "Generate", not a reaction to every keystroke in
    // the name field or every scope toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleScope = useCallback((scope: string) => {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }, []);

  return (
    <SafeScreen style={styles.screen} testID="invite">
      <View style={styles.header}>
        <Kicker color={ink.muted}>ompd</Kicker>
        <Display heading>Invite a device</Display>
        <Body color={ink.plain}>
          Generates a code for one new device. Scan it there to pair; the code is only good once.
        </Body>
      </View>

      <View style={styles.field}>
        <Kicker color={ink.muted}>Device name</Kicker>
        <TextInput
          accessibilityLabel="Device name"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setName}
          spellCheck={false}
          style={[styles.input, type.code]}
          testID="invite-name"
          value={name}
        />
      </View>

      <View style={styles.field}>
        <Kicker color={ink.muted}>Scopes</Kicker>
        <View style={styles.scopes}>
          {ALL_SCOPES.map((scope) => {
            const checked = scopes.has(scope);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                key={scope}
                onPress={() => toggleScope(scope)}
                style={[styles.scope, checked && styles.scopeChecked]}
                testID={`invite-scope-${scope}`}
              >
                <Label color={checked ? signal.sage : ink.plain}>{scope}</Label>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Pressable accessibilityRole="button" onPress={() => void mint()} style={styles.generate} testID="invite-generate">
        <Label color={signal.sage}>Generate</Label>
      </Pressable>

      <View style={styles.result} testID="invite-result">
        {status.kind === "pending" || status.kind === "minting" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={ink.plain} />
          </View>
        ) : status.kind === "error" ? (
          <View style={styles.notice} testID="invite-error">
            <Label color={signal.ochre} style={styles.noticeText}>
              {status.message}
            </Label>
          </View>
        ) : (
          <View style={styles.qr} testID="invite-qr">
            <QRCode size={220} value={status.encoded} />
            <Label color={ink.plain}>{status.label}</Label>
          </View>
        )}
      </View>

      <Pressable accessibilityRole="button" onPress={onDone} style={styles.done} testID="invite-done">
        <Label color={ink.bright}>Done</Label>
      </Pressable>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, gap: space.step, padding: space.loose },
  header: { gap: space.tight },
  field: { gap: space.tight },
  input: {
    backgroundColor: ground.surface,
    borderColor: ground.line,
    borderWidth: stroke.hair,
    color: ink.bright,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  scopes: { flexDirection: "row", flexWrap: "wrap", gap: space.snug },
  scope: {
    alignItems: "center",
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  scopeChecked: { borderColor: signal.sage },
  generate: { alignItems: "center", borderColor: ground.edge, borderWidth: stroke.hair, justifyContent: "center", minHeight: TOUCH_TARGET },
  result: { alignItems: "center", flex: 1, justifyContent: "center" },
  centered: { alignItems: "center", justifyContent: "center" },
  notice: {
    backgroundColor: signalWash.ochre,
    borderLeftColor: signal.ochre,
    borderLeftWidth: stroke.heavy,
    padding: space.step,
  },
  noticeText: { flex: 1 },
  qr: { alignItems: "center", gap: space.step },
  done: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
});
