/**
 * The skills catalogue's reshaping of upstream discovery.
 *
 * Upstream's `discoverSkills`/`discoverSlashCommands` are stood in for with
 * plain data through `listSkillCatalog`'s injected seam, so this file tests
 * this module's own logic -- merging, sorting, and plugin-name derivation --
 * deterministically, without depending on this machine's installed plugins.
 */

import { describe, expect, test } from "bun:test";
import type { FileSlashCommand, Skill } from "@oh-my-pi/pi-coding-agent";
import { listSkillCatalog } from "../src/workspace/skills.ts";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "example-skill",
    description: "An example skill.",
    filePath: "/tmp/example-skill/SKILL.md",
    baseDir: "/tmp/example-skill",
    source: "claude-plugins:project",
    ...overrides,
  };
}

function command(overrides: Partial<FileSlashCommand> = {}): FileSlashCommand {
  return {
    name: "example-command",
    description: "An example command.",
    content: "do the thing",
    source: "via Claude Code (User)",
    ...overrides,
  };
}

describe("listSkillCatalog", () => {
  test("enumerates skills and commands, each reporting where it came from", async () => {
    const catalog = await listSkillCatalog(
      "/tmp/workspace",
      async (cwd) => {
        expect(cwd).toBe("/tmp/workspace");
        return {
          skills: [
            skill({
              name: "absinthe-resolvers",
              source: "claude-plugins:project",
              _source: {
                provider: "claude-plugins",
                providerName: "Claude Code Marketplace",
                level: "project",
                path: "/Users/j/.claude/plugins/cache/jutsu-market/absinthe-graphql/skills/absinthe-resolvers/SKILL.md",
              },
            }),
            skill({
              name: "account-for-every-source-in-a-report",
              source: "omp-managed:user",
              _source: {
                provider: "omp-managed",
                providerName: "Managed Skills (auto-learn)",
                level: "user",
                path: "/Users/j/.omp/agent/managed-skills/account-for-every-source-in-a-report/SKILL.md",
              },
            }),
          ],
          warnings: [],
        };
      },
      async ({ cwd } = {}) => {
        expect(cwd).toBe("/tmp/workspace");
        return [command({ name: "zzz-last-command" })];
      },
    );

    expect(catalog.map((s) => s.name)).toEqual([
      "absinthe-resolvers",
      "account-for-every-source-in-a-report",
      "zzz-last-command",
    ]);

    const plugin = catalog.find((s) => s.name === "absinthe-resolvers");
    expect(plugin).toEqual({
      name: "absinthe-resolvers",
      description: "An example skill.",
      kind: "skill",
      source: "claude-plugins:project",
      providerName: "Claude Code Marketplace",
      level: "project",
      pluginName: "absinthe-graphql",
    });

    // A skill with no plugin in its path reports no pluginName -- the honest
    // answer, not a guess.
    const managed = catalog.find((s) => s.name === "account-for-every-source-in-a-report");
    expect(managed?.pluginName).toBeUndefined();
    expect(managed?.providerName).toBe("Managed Skills (auto-learn)");

    const cmd = catalog.find((s) => s.name === "zzz-last-command");
    expect(cmd?.kind).toBe("command");
    expect(cmd?.source).toBe("via Claude Code (User)");
    expect(cmd?.pluginName).toBeUndefined();
  });

  test("an installed (non-marketplace) plugin root also yields a pluginName", async () => {
    const catalog = await listSkillCatalog(
      undefined,
      async () => ({
        skills: [
          skill({
            name: "installed-plugin-skill",
            _source: {
              provider: "agent-plugins",
              providerName: "Agent Plugins",
              level: "user",
              path: "/Users/j/.omp/agent/plugins/darkrun/skills/darkrun-start/SKILL.md",
            },
          }),
        ],
        warnings: [],
      }),
      async () => [],
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.pluginName).toBe("darkrun");
  });
});
