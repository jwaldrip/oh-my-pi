/**
 * The skills, connectors, and plugins catalogue.
 *
 * Pure functions only — no socket, no fetch, no React. `useCowork.ts` is the
 * one impure edge that turns a `GET /v1/skills` / `GET /v1/connectors`
 * response into the shapes below; everything here is a fold over data it
 * already has, which is what lets a canned fixture and a live daemon produce
 * byte-identical output.
 */

import type { ConnectorStatus, ConnectorSummary, SkillSummary } from "./types.ts";

/** Decoupled from `design/tokens.ts` on purpose — see `tasks.ts` for why. */
export type SignalName = "amber" | "sage" | "ochre" | "oxide" | "slate" | "violet";

// ---------------------------------------------------------------------------
// Plugin grouping
// ---------------------------------------------------------------------------

/**
 * The three-way split the wire contract can honestly support today.
 *
 * `native`: shipped with OMP itself — the org that builds this app
 * publishing to itself, not a plugin at all. `marketplace`: loaded through a
 * packaged-plugin mechanism — installed from *some* marketplace, first- or
 * third-party, the two are indistinguishable without a marketplace-allowlist
 * concept, which does not exist in this codebase (confirmed with
 * CoworkSurface — flagged as a real gap, not fabricated). `local`: everything
 * else — a tool-native config file read directly (`.claude/`, `.mcp.json`, a
 * project `skills/` dir), unpackaged.
 */
export type PluginOrigin = "native" | "marketplace" | "local";

/**
 * `providerName` is the only provenance field both `SkillSummary` and
 * `ConnectorSummary` carry — `source` exists on skills alone. Each loader in
 * packages/coding-agent/src/discovery/*.ts has exactly one `DISPLAY_NAME`
 * constant, so these strings are a stable 1:1 mapping onto the loader that
 * produced an item, not a guess: "OMP" is `builtin.ts`'s native loader;
 * "Claude Code Marketplace" / "Agent Plugins" / "OMP Extension Packages" are
 * the three loaders that read an *installed plugin package* rather than a
 * tool's own config directory.
 */
const NATIVE_PROVIDER_NAMES: Record<string, boolean> = { OMP: true };
const PACKAGED_PLUGIN_PROVIDER_NAMES: Record<string, boolean> = {
  "Claude Code Marketplace": true,
  "Agent Plugins": true,
  "OMP Extension Packages": true,
};

export function deriveOrigin(providerName: string | undefined): PluginOrigin {
  if (providerName === undefined) return "local";
  if (NATIVE_PROVIDER_NAMES[providerName]) return "native";
  if (PACKAGED_PLUGIN_PROVIDER_NAMES[providerName]) return "marketplace";
  return "local";
}

export const ORIGIN_LABELS: Record<PluginOrigin, string> = {
  native: "Built-in",
  marketplace: "Plugin",
  local: "Local",
};

interface Provenanced {
  name: string;
  providerName?: string;
  pluginName?: string;
}

export interface PluginGroup {
  key: string;
  label: string;
  origin: PluginOrigin;
  skills: SkillSummary[];
  connectors: ConnectorSummary[];
}

const ORIGIN_RANK: Record<PluginOrigin, number> = { native: 0, marketplace: 1, local: 2 };

/**
 * Groups skills and connectors by the plugin that owns them. A group's
 * `origin` is read off its first member: everything sharing one grouping key
 * came from one loader, so it shares one origin by construction.
 */
export function groupByPlugin(skills: readonly SkillSummary[], connectors: readonly ConnectorSummary[]): PluginGroup[] {
  const groups = new Map<string, PluginGroup>();
  const ensure = (item: Provenanced): PluginGroup => {
    // Precedence: an installed plugin's own name first, then the loader's
    // display name, then the item's own name as a last resort that is at
    // least never blank.
    const key = item.pluginName ?? item.providerName ?? item.name;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const group: PluginGroup = { key, label: key, origin: deriveOrigin(item.providerName), skills: [], connectors: [] };
    groups.set(key, group);
    return group;
  };
  for (const skill of skills) ensure(skill).skills.push(skill);
  for (const connector of connectors) ensure(connector).connectors.push(connector);
  for (const group of groups.values()) {
    group.skills.sort((a, b) => a.name.localeCompare(b.name));
    group.connectors.sort((a, b) => a.name.localeCompare(b.name));
  }
  return Array.from(groups.values()).sort(
    (a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.label.localeCompare(b.label),
  );
}

// ---------------------------------------------------------------------------
// Skills: search and invocation
// ---------------------------------------------------------------------------

/** What typing `/name` actually sends. */
export function skillInvocation(skill: SkillSummary): string {
  return `/${skill.name}`;
}

/**
 * Filters the `/` menu as the operator types. A leading slash is stripped so
 * `"/dep"` and `"dep"` match identically — the operator has already committed
 * to the menu by opening it, and re-typing the slash it opened with should not
 * empty the list.
 */
export function filterSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const needle = query.trim().replace(/^\//, "").toLowerCase();
  if (needle.length === 0) return skills.slice();
  return skills.filter(
    (skill) => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Connectors: health and credential safety
// ---------------------------------------------------------------------------

export const CONNECTOR_STATUS_SIGNALS: Record<ConnectorStatus, SignalName> = {
  connected: "sage",
  connecting: "amber",
  disconnected: "oxide",
};

export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
};

export interface ConnectorHealth {
  connected: ConnectorSummary[];
  down: ConnectorSummary[];
}

/** Splits the roster into what's working and what needs a reason shown. */
export function connectorHealth(connectors: readonly ConnectorSummary[]): ConnectorHealth {
  const connected: ConnectorSummary[] = [];
  const down: ConnectorSummary[] = [];
  for (const connector of connectors) {
    (connector.status === "connected" ? connected : down).push(connector);
  }
  connected.sort((a, b) => a.name.localeCompare(b.name));
  down.sort((a, b) => a.name.localeCompare(b.name));
  return { connected, down };
}

/**
 * Coarse patterns for text shaped like a live credential: a bearer scheme, a
 * common vendor key prefix, a bare high-entropy token run, or a header name
 * that only ever precedes one. This is a backstop, not the redaction — the
 * daemon redacts `error` before it ships (per CoworkSurface). A backstop that
 * never fires is still worth having: the one time it does is the one time the
 * daemon's redaction had a bug, and "never render a credential" has to hold
 * even then.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bAuthorization\s*:/i,
  /\bapi[_-]?key\b\s*[:=]/i,
  /\b[A-Za-z0-9_-]{40,}\b/,
];

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

const WITHHELD_REASON = "Connector reported an error that looked like it might contain a credential, so it was withheld. This is a bug worth reporting, not expected behavior.";
const NO_REASON = "No reason reported.";

/**
 * What a down connector's row actually shows. Never blank — an unexplained
 * failure reads as broken tooling, not as "nothing to see" — and never a
 * credential, even if one somehow reached this far.
 */
export function connectorReason(connector: ConnectorSummary): string {
  if (connector.status === "connected") return "";
  const raw = connector.error;
  if (raw === undefined || raw.trim().length === 0) return NO_REASON;
  if (looksLikeCredential(raw)) return WITHHELD_REASON;
  return raw;
}
