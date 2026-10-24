import type { OmpModelRolesResponse, OmpSettingsResponse, OmpSettingsValues } from "@ompd/core";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { RoleCyclePicker, type CycleRole } from "../components/RoleCyclePicker.tsx";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { restRoot } from "../cowork/useCowork.ts";

const EMPTY_ROLES: OmpModelRolesResponse = {
  roles: { default: null, smol: null, slow: null, plan: null, task: null },
  cycleOrder: ["default", "smol", "slow", "plan"],
};

interface ApiError {
  error?: unknown;
}


export function OmpSettingsScreen({ connection, onBack }: { connection: Connection; onBack: () => void }): JSX.Element {
  const root = connection.transport === "direct" ? restRoot(connection.url) : null;
  const [roles, setRoles] = useState<OmpModelRolesResponse>(EMPTY_ROLES);
  const [selected, setSelected] = useState<CycleRole>("default");
  const [model, setModel] = useState("");
  const [taskModel, setTaskModel] = useState("");
  const [settingsText, setSettingsText] = useState("{}");
  const [settingsSnapshot, setSettingsSnapshot] = useState<OmpSettingsValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      if (root === null) throw new Error("OMP settings require a direct daemon connection");
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${connection.token}`);
      return fetch(`${root}${path}`, { ...init, headers });
    },
    [connection.token, root],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rolesResponse, settingsResponse] = await Promise.all([request("/v1/omp/roles"), request("/v1/omp/settings")]);
      if (!rolesResponse.ok || !settingsResponse.ok) {
        throw new Error(`daemon returned ${rolesResponse.status}/${settingsResponse.status}`);
      }
      const [nextRoles, nextSettings] = (await Promise.all([rolesResponse.json(), settingsResponse.json()])) as [
        OmpModelRolesResponse,
        OmpSettingsResponse,
      ];
      setRoles(nextRoles);
      setModel(nextRoles.roles[selected] ?? "");
      setTaskModel(nextRoles.roles.task ?? "");
      setSettingsText(JSON.stringify(nextSettings.settings, null, 2));
      setSettingsSnapshot(nextSettings.settings);
      setNotice(null);
    } catch (cause) {
      setNotice(describe(cause));
    } finally {
      setLoading(false);
    }
  }, [request, selected]);

  useEffect(() => void load(), [load]);

  const changeRole = (role: CycleRole): void => {
    setSelected(role);
    setModel(roles.roles[role] ?? "");
  };

  const saveRoles = async (next: Record<string, string | null>): Promise<void> => {
    setSaving(true);
    try {
      const response = await request("/v1/omp/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: next }),
      });
      const body = (await response.json()) as OmpModelRolesResponse & ApiError;
      if (!response.ok) throw new Error(errorMessage(body, response.status));
      setRoles(body);
      setModel(body.roles[selected] ?? "");
      setTaskModel(body.roles.task ?? "");
      setNotice("Model override saved");
    } catch (cause) {
      setNotice(describe(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    let settings: unknown;
    try {
      settings = JSON.parse(settingsText);
    } catch {
      setNotice("Settings must be valid JSON");
      return;
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).length === 0) {
      setNotice("Settings must be a non-empty object");
      return;
    }
    const changed = changedSettings(settingsSnapshot, settings as OmpSettingsValues);
    if (Object.keys(changed).length === 0) {
      setNotice("No settings changed");
      return;
    }
    setSaving(true);
    try {
      const response = await request("/v1/omp/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: changed }),
      });
      const body = (await response.json()) as OmpSettingsResponse & ApiError;
      if (!response.ok) throw new Error(errorMessage(body, response.status));
      setSettingsText(JSON.stringify(body.settings, null, 2));
      setSettingsSnapshot(body.settings);
      setNotice("Settings saved");
    } catch (cause) {
      setNotice(describe(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeScreen style={styles.screen} testID="omp-settings-screen">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack} style={styles.back}>
          <Glyph name="back" color={ink.plain} />
          <Label color={ink.plain}>Sessions</Label>
        </Pressable>
        <Kicker color={ink.muted}>omp configuration</Kicker>
        <Display heading>Models and settings</Display>
        <Body color={ink.plain}>
          Changes go through the daemon. Credentials are not displayed or editable here.
        </Body>

        {notice === null ? null : (
          <View accessibilityLiveRegion="assertive" style={styles.notice} testID="omp-settings-notice">
            <Glyph name="warning" color={signal.ochre} />
            <Label color={signal.ochre} style={styles.noticeText}>{notice}</Label>
          </View>
        )}

        <Section title="Interactive role">
          <RoleCyclePicker value={selected} onChange={changeRole} disabled={loading || saving} />
          <Field
            label={`${selected} model override`}
            value={model}
            onChange={setModel}
            placeholder="provider/model[:thinking]"
            testID="omp-settings-model"
          />
          <Action label="Save model override" disabled={loading || saving} onPress={() => void saveRoles({ [selected]: model.trim() || null })} />
        </Section>

        <Section title="Task role">
          <Body color={ink.muted}>Used for delegated work that should not inherit the interactive role.</Body>
          <Field label="task model override" value={taskModel} onChange={setTaskModel} placeholder="provider/model[:thinking]" testID="omp-settings-task-model" />
          <Action label="Save task model" disabled={loading || saving} onPress={() => void saveRoles({ task: taskModel.trim() || null })} />
        </Section>

        <Section title="Current role assignments">
          {Object.entries(roles.roles).map(([role, assignment]) => (
            <View key={role} style={styles.assignment}>
              <Kicker color={ink.muted}>{role}</Kicker>
              <Label color={assignment === null ? ink.faint : ink.plain} style={styles.assignmentValue}>{assignment ?? "OMP default"}</Label>
            </View>
          ))}
        </Section>

        <Section title="Settings.yml values">
          <Body color={ink.muted}>A JSON editor for the safe, non-credential OMP settings read from settings.yml.</Body>
          <TextInput
            accessibilityLabel="OMP settings JSON"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setSettingsText}
            scrollEnabled={false}
            spellCheck={false}
            style={styles.editor}
            testID="omp-settings-editor"
            value={settingsText}
          />
          <Action label="Save settings" disabled={loading || saving} onPress={() => void saveSettings()} />
        </Section>
      </ScrollView>
    </SafeScreen>
  );
}

function Section({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <View style={styles.section}>
      <Kicker color={signal.violet}>{title}</Kicker>
      {children}
    </View>
  );
}

function Field({ label, value, onChange, placeholder, testID }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; testID: string }): JSX.Element {
  return (
    <View style={styles.field}>
      <Kicker color={ink.muted}>{label}</Kicker>
      <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={ink.faint} spellCheck={false} style={styles.input} testID={testID} value={value} />
    </View>
  );
}

function Action({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
      <Label color={disabled ? ink.faint : signal.sage}>{label}</Label>
    </Pressable>
  );
}

/** Values loaded for review never become writes until an operator changes one. */
export function changedSettings(previous: OmpSettingsValues, submitted: OmpSettingsValues): OmpSettingsValues {
  const changed: OmpSettingsValues = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (JSON.stringify(value) !== JSON.stringify(previous[key])) changed[key] = value;
  }
  return changed;
}

function errorMessage(body: ApiError, status: number): string {
  return typeof body.error === "string" ? body.error : `daemon returned ${status}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  action: { alignItems: "center", borderColor: signal.sage, borderWidth: stroke.hair, justifyContent: "center", minHeight: TOUCH_TARGET, paddingHorizontal: space.step },
  assignment: { borderBottomColor: ground.line, borderBottomWidth: stroke.hair, gap: space.hair, paddingVertical: space.snug },
  assignmentValue: { ...type.code },
  back: { alignItems: "center", flexDirection: "row", gap: space.snug, minHeight: TOUCH_TARGET },
  content: { alignSelf: "center", gap: space.step, maxWidth: 640, padding: space.loose, width: "100%" },
  disabled: { borderColor: ground.edge, opacity: 0.45 },
  editor: { ...type.code, backgroundColor: ground.surface, borderColor: ground.line, borderWidth: stroke.hair, color: ink.bright, minHeight: 180, padding: space.step, textAlignVertical: "top" },
  field: { gap: space.tight },
  input: { ...type.code, backgroundColor: ground.surface, borderColor: ground.line, borderWidth: stroke.hair, color: ink.bright, minHeight: TOUCH_TARGET, paddingHorizontal: space.step },
  notice: { alignItems: "center", backgroundColor: signalWash.ochre, borderLeftColor: signal.ochre, borderLeftWidth: stroke.heavy, flexDirection: "row", gap: space.snug, padding: space.step },
  noticeText: { flex: 1 },
  pressed: { backgroundColor: ground.active },
  screen: { backgroundColor: ground.base },
  section: { backgroundColor: ground.raised, borderColor: ground.edge, borderWidth: stroke.hair, gap: space.step, padding: space.step },
});
