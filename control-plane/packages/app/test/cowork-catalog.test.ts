/**
 * The skill/connector/plugin catalogue's pure functions, driven directly.
 */

import { describe, expect, test } from "bun:test";
import {
  connectorHealth,
  connectorReason,
  deriveOrigin,
  filterSkills,
  groupByPlugin,
  looksLikeCredential,
  ORIGIN_LABELS,
  skillInvocation,
} from "../src/cowork/catalog.ts";
import type { ConnectorSummary, SkillSummary } from "../src/cowork/types.ts";

function skill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return { name, description: `does ${name}`, kind: "skill", source: "native:native", ...overrides };
}

function connector(name: string, overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return { name, connected: true, status: "connected", ...overrides };
}

// ---------------------------------------------------------------------------
// Plugin origin
// ---------------------------------------------------------------------------

describe("deriveOrigin", () => {
  test("OMP's own loader is native", () => {
    expect(deriveOrigin("OMP")).toBe("native");
  });

  test("every packaged-plugin loader is marketplace", () => {
    expect(deriveOrigin("Claude Code Marketplace")).toBe("marketplace");
    expect(deriveOrigin("Agent Plugins")).toBe("marketplace");
    expect(deriveOrigin("OMP Extension Packages")).toBe("marketplace");
  });

  test("a tool-native config reader, or no provider at all, is local", () => {
    expect(deriveOrigin("Claude Code")).toBe("local");
    expect(deriveOrigin("Cursor")).toBe("local");
    expect(deriveOrigin(undefined)).toBe("local");
  });

  test("every origin has a display label — the mapping is total", () => {
    expect(ORIGIN_LABELS.native).toBeTruthy();
    expect(ORIGIN_LABELS.marketplace).toBeTruthy();
    expect(ORIGIN_LABELS.local).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Grouping by plugin
// ---------------------------------------------------------------------------

describe("groupByPlugin", () => {
  test("skills sharing a plugin name land in one group, real per-plugin grouping when the data has it", () => {
    const groups = groupByPlugin(
      [
        skill("deploy", { providerName: "Claude Code Marketplace", pluginName: "cld" }),
        skill("review", { providerName: "Claude Code Marketplace", pluginName: "cld" }),
        skill("dispatch", { providerName: "Claude Code Marketplace", pluginName: "haiku-method" }),
      ],
      [],
    );
    expect(groups).toHaveLength(2);
    const cld = groups.find((g) => g.key === "cld");
    expect(cld?.skills.map((s) => s.name)).toEqual(["deploy", "review"]);
    const haiku = groups.find((g) => g.key === "haiku-method");
    expect(haiku?.skills.map((s) => s.name)).toEqual(["dispatch"]);
  });

  test("without a plugin name, items fall back to the loader's display name rather than scattering singly", () => {
    const groups = groupByPlugin(
      [skill("a", { providerName: "Claude Code", pluginName: undefined }), skill("b", { providerName: "Claude Code", pluginName: undefined })],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Claude Code");
  });

  test("a group's key is never blank even with no plugin name and no provider name", () => {
    const groups = groupByPlugin([skill("bare-skill", { providerName: undefined, pluginName: undefined })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key.length).toBeGreaterThan(0);
    expect(groups[0]?.key).toBe("bare-skill");
  });

  test("a plugin group carries both the skills and the connectors it owns", () => {
    const groups = groupByPlugin(
      [skill("deploy", { providerName: "OMP Extension Packages", pluginName: "infra" })],
      [connector("infra-db", { providerName: "OMP Extension Packages", pluginName: "infra" })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(groups[0]?.connectors.map((c) => c.name)).toEqual(["infra-db"]);
  });

  test("groups order native first, then marketplace, then local, alphabetically within a tier", () => {
    const groups = groupByPlugin(
      [
        skill("z-local", { providerName: "Cursor" }),
        skill("a-native", { providerName: "OMP", pluginName: undefined }),
        skill("z-market", { providerName: "Claude Code Marketplace", pluginName: "zeta" }),
        skill("a-market", { providerName: "Claude Code Marketplace", pluginName: "alpha" }),
      ],
      [],
    );
    expect(groups.map((g) => g.origin)).toEqual(["native", "marketplace", "marketplace", "local"]);
    expect(groups.map((g) => g.label)).toEqual(["OMP", "alpha", "zeta", "Cursor"]);
  });

  test("a realistic corpus (dozens of plugins) groups cleanly with no crossover", () => {
    const skills: SkillSummary[] = [];
    for (let i = 0; i < 40; i += 1) {
      skills.push(skill(`skill-${i}`, { providerName: "Claude Code Marketplace", pluginName: `plugin-${i % 12}` }));
    }
    const groups = groupByPlugin(skills, []);
    expect(groups).toHaveLength(12);
    const total = groups.reduce((sum, group) => sum + group.skills.length, 0);
    expect(total).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Skills: invocation and search
// ---------------------------------------------------------------------------

describe("skillInvocation and filterSkills", () => {
  test("invocation is the slash form of the skill's own name", () => {
    expect(skillInvocation(skill("deploy-prod"))).toBe("/deploy-prod");
  });

  test("an empty query returns the whole list", () => {
    const skills = [skill("a"), skill("b")];
    expect(filterSkills(skills, "")).toEqual(skills);
  });

  test("a leading slash the operator typed does not exclude everything", () => {
    const skills = [skill("deploy")];
    expect(filterSkills(skills, "/dep")).toEqual(skills);
  });

  test("matches on name or on description, case-insensitively", () => {
    const skills = [skill("alpha", { description: "handles onboarding" }), skill("beta", { description: "ships releases" })];
    expect(filterSkills(skills, "ONBOARD").map((s) => s.name)).toEqual(["alpha"]);
    expect(filterSkills(skills, "SHIP").map((s) => s.name)).toEqual(["beta"]);
  });

  test("no match is an empty list, not an exception or the full catalogue", () => {
    expect(filterSkills([skill("alpha")], "nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connector health
// ---------------------------------------------------------------------------

describe("connectorHealth", () => {
  test("splits connected from every non-connected state", () => {
    const health = connectorHealth([
      connector("up", { status: "connected", connected: true }),
      connector("connecting", { status: "connecting", connected: false }),
      connector("down", { status: "disconnected", connected: false, error: "ECONNREFUSED" }),
    ]);
    expect(health.connected.map((c) => c.name)).toEqual(["up"]);
    expect(health.down.map((c) => c.name)).toEqual(["connecting", "down"]);
  });

  test("a down connector's reason is surfaced, not hidden behind a generic status word", () => {
    const health = connectorHealth([
      connector("stripe", { status: "disconnected", connected: false, error: "OAuth token expired 2026-01-01T00:00:00Z" }),
    ]);
    const stripe = health.down.find((c) => c.name === "stripe");
    expect(stripe).toBeDefined();
    expect(connectorReason(stripe as ConnectorSummary)).toBe("OAuth token expired 2026-01-01T00:00:00Z");
  });

  test("a down connector with no reason still says so rather than rendering blank", () => {
    const health = connectorHealth([connector("silent", { status: "disconnected", connected: false })]);
    expect(connectorReason(health.down[0] as ConnectorSummary)).toBe("No reason reported.");
  });

  test("a realistic corpus (dozens of connectors, several kinds of down) reports every reason", () => {
    const connectors: ConnectorSummary[] = [];
    for (let i = 0; i < 30; i += 1) connectors.push(connector(`up-${i}`, { status: "connected", connected: true }));
    for (let i = 0; i < 5; i += 1) {
      connectors.push(connector(`down-${i}`, { status: "disconnected", connected: false, error: `error ${i}` }));
    }
    const health = connectorHealth(connectors);
    expect(health.connected).toHaveLength(30);
    expect(health.down).toHaveLength(5);
    for (const down of health.down) expect(connectorReason(down).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Never render a credential
// ---------------------------------------------------------------------------

describe("credential safety", () => {
  test("looksLikeCredential recognizes a bearer token, an API key prefix, and a bare high-entropy run", () => {
    expect(looksLikeCredential("failed: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(looksLikeCredential("api_key: 1234567890abcdef1234567890abcdef")).toBe(true);
    expect(looksLikeCredential("token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP")).toBe(true);
  });

  test("an ordinary failure message is not flagged", () => {
    expect(looksLikeCredential("ECONNREFUSED 127.0.0.1:5432")).toBe(false);
    expect(looksLikeCredential("OAuth token expired")).toBe(false);
    expect(looksLikeCredential("connection timed out after 30s")).toBe(false);
  });

  test("connectorReason withholds a credential-shaped error rather than rendering it verbatim", () => {
    const leaked = connector("compromised", {
      status: "disconnected",
      connected: false,
      error: "auth failed: Authorization: Bearer sk-live-4242424242424242424242424242",
    });
    const shown = connectorReason(leaked);
    expect(shown).not.toContain("sk-live-4242424242424242424242424242");
    expect(shown).not.toContain("Bearer");
    expect(shown.length).toBeGreaterThan(0);
  });
});
