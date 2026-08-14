/**
 * The three catalogue views: skills to invoke, connectors to check, plugins
 * that group them. Each is a thin composition over `cowork/catalog.ts`'s pure
 * functions — grouping, health, search all decided there; these lay out the
 * result.
 */

import type { JSX, ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { connectorHealth, groupByPlugin, ORIGIN_LABELS } from "../cowork/catalog.ts";
import type { PluginGroup } from "../cowork/catalog.ts";
import type { ConnectorSummary, SkillSummary } from "../cowork/types.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Body, Data, Kicker, Label } from "../design/text.tsx";
import { ground, ink, space, stroke } from "../design/tokens.ts";
import { ConnectorRow } from "./ConnectorRow.tsx";
import { PluginBadge } from "./PluginBadge.tsx";
import { SkillCard } from "./SkillCard.tsx";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillsViewProps {
  skills: readonly SkillSummary[];
  onInvoke: (skill: SkillSummary) => void;
}

export function SkillsView({ skills, onInvoke }: SkillsViewProps): JSX.Element {
  return (
    <ScrollView testID="skills-view" contentContainerStyle={styles.list}>
      <Head glyph="skill" count={skills.length} noun="skill" testID="skills-count" />
      {skills.length === 0 ? (
        <Empty
          glyph="skill"
          title="No skills discovered."
          hint="A skill lives under skills/ in a plugin or an OMP config directory."
        />
      ) : (
        skills.map((skill) => (
          <SkillCard key={`${skill.kind}:${skill.name}:${skill.source}`} skill={skill} onInvoke={onInvoke} />
        ))
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export function ConnectorsView({ connectors }: { connectors: readonly ConnectorSummary[] }): JSX.Element {
  const health = connectorHealth(connectors);

  return (
    <ScrollView testID="connectors-view" contentContainerStyle={styles.list}>
      <Head glyph="connector" count={connectors.length} noun="connector" testID="connectors-count" />
      {connectors.length === 0 ? (
        <Empty glyph="connector" title="No connectors configured." hint="Wire one in .mcp.json or a plugin's own config." />
      ) : (
        <>
          {health.down.length > 0 ? (
            <Section label={`Needs attention (${health.down.length})`}>
              {health.down.map((connector) => (
                <ConnectorRow key={connector.name} connector={connector} />
              ))}
            </Section>
          ) : null}
          {health.connected.length > 0 ? (
            <Section label={`Connected (${health.connected.length})`}>
              {health.connected.map((connector) => (
                <ConnectorRow key={connector.name} connector={connector} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginsViewProps {
  skills: readonly SkillSummary[];
  connectors: readonly ConnectorSummary[];
}

export function PluginsView({ skills, connectors }: PluginsViewProps): JSX.Element {
  const groups = groupByPlugin(skills, connectors);

  return (
    <ScrollView testID="plugins-view" contentContainerStyle={styles.list}>
      <Head glyph="plugin" count={groups.length} noun="plugin" testID="plugins-count" />
      {groups.length === 0 ? (
        <Empty glyph="plugin" title="No plugins discovered." />
      ) : (
        groups.map((group) => <PluginGroupCard key={group.key} group={group} />)
      )}
    </ScrollView>
  );
}

function PluginGroupCard({ group }: { group: PluginGroup }): JSX.Element {
  return (
    <View style={styles.group} testID={`plugin-group-${group.key}`}>
      <View style={styles.groupHead}>
        <PluginBadge origin={group.origin} label={group.label} testID={`plugin-group-${group.key}-badge`} />
        <Label color={ink.muted}>{ORIGIN_LABELS[group.origin]}</Label>
        <Data color={ink.faint} style={styles.groupCounts}>{`${group.skills.length} skill${
          group.skills.length === 1 ? "" : "s"
        } · ${group.connectors.length} connector${group.connectors.length === 1 ? "" : "s"}`}</Data>
      </View>
      {group.skills.map((skill) => (
        <SkillRow key={`${skill.kind}:${skill.name}:${skill.source}`} skill={skill} />
      ))}
      {group.connectors.map((connector) => (
        <ConnectorNameRow key={connector.name} connector={connector} />
      ))}
    </View>
  );
}

/** A skill inside its plugin group: name and kind only — the group already carries provenance, so `SkillCard`'s own badge would repeat it. */
function SkillRow({ skill }: { skill: SkillSummary }): JSX.Element {
  return (
    <View style={styles.memberRow} testID={`plugin-group-skill-${skill.name}`}>
      <Glyph name={skill.kind === "command" ? "commands" : "skill"} size={11} color={ink.faint} />
      <Label color={ink.plain} numberOfLines={1}>{`/${skill.name}`}</Label>
    </View>
  );
}

function ConnectorNameRow({ connector }: { connector: ConnectorSummary }): JSX.Element {
  return (
    <View style={styles.memberRow} testID={`plugin-group-connector-${connector.name}`}>
      <Glyph name="connector" size={11} color={ink.faint} />
      <Label color={ink.plain} numberOfLines={1}>
        {connector.name}
      </Label>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function Head({ glyph, count, noun, testID }: { glyph: GlyphName; count: number; noun: string; testID: string }): JSX.Element {
  return (
    <View style={styles.head}>
      <Glyph name={glyph} size={16} color={ink.plain} />
      <Kicker color={ink.muted} testID={testID}>{`${count} ${count === 1 ? noun : `${noun}s`}`}</Kicker>
    </View>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <View>
      <Kicker color={ink.muted} style={styles.sectionLabel}>
        {label}
      </Kicker>
      {children}
    </View>
  );
}

function Empty({ glyph, title, hint }: { glyph: GlyphName; title: string; hint?: string }): JSX.Element {
  return (
    <View style={styles.empty}>
      <Glyph name={glyph} size={22} color={ground.edge} />
      <Body color={ink.plain}>{title}</Body>
      {hint !== undefined ? <Label color={ink.muted}>{hint}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  sectionLabel: { paddingHorizontal: space.wide, paddingTop: space.step, paddingBottom: space.tight, letterSpacing: 1 },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
  group: { borderBottomWidth: stroke.heavy, borderBottomColor: ground.edge, paddingVertical: space.step },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingBottom: space.snug,
  },
  groupCounts: { marginLeft: "auto" },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.wide,
    paddingVertical: space.tight,
  },
});
