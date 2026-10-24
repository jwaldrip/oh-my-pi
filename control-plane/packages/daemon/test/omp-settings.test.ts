import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OmpSettings } from "../src/omp-settings.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function agentDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ompd-omp-settings-"));
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  return directory;
}

function writeModelCatalog(agentDir: string, models: Record<string, string[]>): void {
  const database = new Database(join(agentDir, "models.db"));
  database.run("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT NOT NULL)");
  for (const [provider, ids] of Object.entries(models)) {
    database.run("INSERT INTO model_cache (provider_id, models) VALUES (?, ?)", [
      provider,
      JSON.stringify(ids.map((id) => ({ id }))),
    ]);
  }
  database.close();
}

describe("OmpSettings", () => {
  test("returns schema-backed public settings and persists a validated key-value update", async () => {
    const agentDir = agentDirectory();
    const settings = new OmpSettings({ agentDir });

    const initial = await settings.readSettings();
    expect(initial.settings.modelRoleStorage).toBe("global");
    expect("auth.broker.token" in initial.settings).toBe(false);
    expect("modelRoles" in initial.settings).toBe(false);
    expect("cycleOrder" in initial.settings).toBe(false);

    const updated = await settings.updateSettings({
      settings: {
        modelRoleStorage: "project",
        "providers.maxInFlightRequests": { openai: 2 },
      },
    });

    expect(updated.settings.modelRoleStorage).toBe("project");
    expect(updated.settings["providers.maxInFlightRequests"]).toEqual({ openai: 2 });
    const config = readFileSync(join(agentDir, "config.yml"), "utf8");
    expect(config).toContain("modelRoleStorage: project");
    expect(config).not.toContain("cycleOrder:");
    expect(config).not.toContain("modelRoles:");
  });

  test("rejects unknown, secret, and incorrectly typed setting values without writing them", async () => {
    const agentDir = agentDirectory();
    const settings = new OmpSettings({ agentDir });

    await expect(settings.updateSettings({ settings: { unknown: true } })).rejects.toThrow(/unknown OMP setting/i);
    await expect(settings.updateSettings({ settings: { "auth.broker.token": "secret" } })).rejects.toThrow(/credential/i);
    await expect(settings.updateSettings({ settings: { modelRoleStorage: true } })).rejects.toThrow(/must be one of/i);
  });

  test("persists only catalog-resolved role overrides and keeps a role cycle explicit", async () => {
    const agentDir = agentDirectory();
    writeModelCatalog(agentDir, {
      "openai-codex": ["gpt-5-4"],
      anthropic: ["claude-sonnet-4-6"],
      openrouter: ["z-ai/glm-4.7"],
    });
    const settings = new OmpSettings({ agentDir });

    const updated = await settings.updateRoles({
      roles: {
        default: "openai-codex/gpt-5-4:high",
        slow: "openrouter/z-ai/glm-4.7",
        task: "anthropic/claude-sonnet-4-6",
      },
      cycleOrder: ["default", "smol", "slow", "plan"],
    });

    expect(updated.roles.default).toBe("openai-codex/gpt-5-4:high");
    expect(updated.roles.task).toBe("anthropic/claude-sonnet-4-6");
    expect(updated.roles.slow).toBe("openrouter/z-ai/glm-4.7");
    expect(updated.cycleOrder).toEqual(["default", "smol", "slow", "plan"]);
    await expect(settings.updateRoles({ roles: { slow: "openai-codex/not-a-model" } })).rejects.toThrow(
      /not in the local OMP model catalog/i,
    );
    await expect(settings.updateRoles({ roles: { slow: "openai-codex/gpt-5-4:garbage" } })).rejects.toThrow(
      /not in the local OMP model catalog/i,
    );
  });
});
