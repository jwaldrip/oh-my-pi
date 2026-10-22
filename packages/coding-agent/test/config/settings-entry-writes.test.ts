import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Editing one fallback chain or one agent must persist only that entry: every entry another layer
// (a `--config` overlay) supplies stays out of config.yml.
interface FixtureTraceIdentity {
	readonly id: number;
	readonly rootPath?: string;
	readonly agentDir?: string;
	readonly cwd?: string;
	readonly overlayPath?: string;
	readonly configPath?: string;
}

interface SettingsFixture extends FixtureTraceIdentity {
	readonly tempDir: TempDir;
	readonly rootPath: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly overlayPath: string;
	readonly configPath: string;
	load(config: RawSettings, overlay: RawSettings): Promise<Settings>;
	readConfig(marker?: string): Promise<RawSettings>;
}

const lifecycleTraceEnabled = Bun.env.OMP_TEST_LIFECYCLE_TRACE === "1";

function lifecycleTrace(
	marker: string,
	phase: "start" | "end",
	fixture: FixtureTraceIdentity | undefined,
	durationMs?: number,
): void {
	if (!lifecycleTraceEnabled) return;
	const paths =
		fixture?.rootPath === undefined
			? ""
			: ` root=${JSON.stringify(fixture.rootPath)} agentDir=${JSON.stringify(fixture.agentDir)} cwd=${JSON.stringify(fixture.cwd)} overlayPath=${JSON.stringify(fixture.overlayPath)} configPath=${JSON.stringify(fixture.configPath)}`;
	const duration = durationMs === undefined ? "" : ` duration_ms=${durationMs.toFixed(1)}`;
	process.stderr.write(
		`[settings-entry-writes] pid=${process.pid} fixture=${fixture?.id ?? "none"} marker=${marker}:${phase}${duration}${paths}\n`,
	);
}

function traceSync<T>(marker: string, fixture: FixtureTraceIdentity | undefined, operation: () => T): T {
	const startedAt = performance.now();
	lifecycleTrace(marker, "start", fixture);
	try {
		return operation();
	} finally {
		lifecycleTrace(marker, "end", fixture, performance.now() - startedAt);
	}
}

async function traceAsync<T>(
	marker: string,
	fixture: FixtureTraceIdentity | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	lifecycleTrace(marker, "start", fixture);
	try {
		return await operation();
	} finally {
		lifecycleTrace(marker, "end", fixture, performance.now() - startedAt);
	}
}

describe("Settings entry-level writes", () => {
	let state: SettingsTestState | undefined;
	let fixture: SettingsFixture | undefined;
	let nextFixtureId = 0;
	const ownedRoots = new Set<TempDir>();

	beforeEach(() => {
		state = traceSync("settings-snapshot-reset", undefined, beginSettingsTest);
		fixture = createFixture();
	});

	afterEach(() => {
		const closingFixture = fixture;
		fixture = undefined;
		const closingState = state;
		state = undefined;
		try {
			traceSync("state-restore", closingFixture, () => restoreSettingsTestState(closingState));
		} finally {
			try {
				traceSync("agent-storage-close", closingFixture, () => AgentStorage.close());
			} finally {
				try {
					traceSync("bun-gc", closingFixture, () => Bun.gc(true));
				} finally {
					if (closingFixture !== undefined && ownedRoots.delete(closingFixture.tempDir)) {
						traceSync("fixture-sync-removal", closingFixture, () => closingFixture.tempDir.removeSync());
					}
				}
			}
		}
	});

	function fixtureForTest(): SettingsFixture {
		if (fixture === undefined) throw new Error("Expected settings fixture from beforeEach");
		return fixture;
	}

	function createFixture(): SettingsFixture {
		const identity = { id: ++nextFixtureId };
		const tempCreateStartedAt = performance.now();
		lifecycleTrace("temp-create", "start", identity);
		const tempDir = TempDir.createSync("@pi-settings-entries-");
		ownedRoots.add(tempDir);
		const rootPath = tempDir.path();
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		const overlayPath = tempDir.join("overlay.yml");
		const configPath = path.join(agentDir, "config.yml");
		const traceFixture = { ...identity, rootPath, agentDir, cwd, overlayPath, configPath };
		lifecycleTrace("temp-create", "end", traceFixture, performance.now() - tempCreateStartedAt);
		traceSync("fixture-mkdir", traceFixture, () => {
			for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		});

		return {
			...traceFixture,
			tempDir,
			async load(config: RawSettings, overlay: RawSettings): Promise<Settings> {
				await traceAsync("fixture-writes", traceFixture, async () => {
					await Bun.write(configPath, YAML.stringify(config));
					await Bun.write(overlayPath, YAML.stringify(overlay));
				});
				return traceAsync("settings-load-isolated", traceFixture, () =>
					Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] }),
				);
			},
			readConfig: async (marker = "settings-readback"): Promise<RawSettings> =>
				traceAsync(marker, traceFixture, async () => YAML.parse(await Bun.file(configPath).text()) as RawSettings),
		};
	}

	it("persists one fallback chain without the chains a --config overlay supplies", async () => {
		const testFixture = fixtureForTest();
		const settings = await testFixture.load({}, { retry: { fallbackChains: { smol: ["overlay/cheap"] } } });

		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow-fallback"]);
		await traceAsync("first-case-flush", testFixture, () => settings.flush());

		expect(await testFixture.readConfig("first-case-readback")).toEqual({
			retry: { fallbackChains: { slow: ["user/slow-fallback"] } },
		});
		expect(cfgRetryFallbackChains.get(settings)).toEqual({
			smol: ["overlay/cheap"],
			slow: ["user/slow-fallback"],
		});
	});

	it("addresses a dotted record key exactly, across an external edit, and deletes it on undefined", async () => {
		const testFixture = fixtureForTest();
		const settings = await testFixture.load({ retry: { fallbackChains: { slow: ["user/slow"] } } }, {});

		cfgRetryFallbackChains.setEntry(settings, "openai/gpt-5.4", ["openai/gpt-5.4-mini"]);
		// Another process edits config.yml before the save merges this write into it.
		await Bun.write(
			testFixture.configPath,
			YAML.stringify({ temperature: 0.3, retry: { fallbackChains: { slow: ["user/slow"] } } }),
		);
		await settings.flush();
		expect(await testFixture.readConfig()).toEqual({
			temperature: 0.3,
			retry: { fallbackChains: { slow: ["user/slow"], "openai/gpt-5.4": ["openai/gpt-5.4-mini"] } },
		});

		cfgRetryFallbackChains.setEntry(settings, "openai/gpt-5.4", undefined);
		await settings.flush();
		expect(await testFixture.readConfig()).toEqual({ temperature: 0.3, retry: { fallbackChains: { slow: ["user/slow"] } } });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ slow: ["user/slow"] });
	});

	it("saves a whole-record write made while a save of one of its entries waits for the config lock", async () => {
		const testFixture = fixtureForTest();
		const settings = await testFixture.load({ retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } }, {});
		cfgRetryFallbackChains.setEntry(settings, "slow", ["intermediate/slow"]);

		const lock = await acquireFileLock(testFixture.configPath);
		let entrySave: Promise<void> | undefined;
		try {
			// This save captures the entry write, then cannot read config.yml before the whole record is set.
			entrySave = settings.flush();
			cfgRetryFallbackChains.set(settings, { slow: ["final/slow"], smol: ["final/smol"] });
		} finally {
			lock.release();
		}
		await entrySave;
		await settings.flush();

		expect(await testFixture.readConfig()).toEqual({
			retry: { fallbackChains: { slow: ["final/slow"], smol: ["final/smol"] } },
		});
	});

	it.each([
		{
			edited: "another setting",
			external: { temperature: 0.3, retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } },
			saved: { temperature: 0.3, retry: { fallbackChains: { slow: ["final/slow"], smol: ["final/smol"] } } },
		},
		{
			edited: "an entry only the whole-record write sets",
			external: { retry: { fallbackChains: { slow: ["old/slow"], smol: ["external/smol"] } } },
			saved: { retry: { fallbackChains: { slow: ["final/slow"], smol: ["external/smol"] } } },
		},
	])(
		"merges an entry write and a later whole-record write with an external edit of $edited",
		async ({ external, saved }) => {
			const testFixture = fixtureForTest();
			const settings = await testFixture.load({ retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } }, {});

			cfgRetryFallbackChains.setEntry(settings, "slow", ["intermediate/slow"]);
			cfgRetryFallbackChains.set(settings, { slow: ["final/slow"], smol: ["final/smol"] });
			await Bun.write(testFixture.configPath, YAML.stringify(external));
			await settings.flush();

			expect(await testFixture.readConfig()).toEqual(saved);
		},
	);

	it("writes an entry into a record malformed as a list, keeping the entries an overlay supplies", async () => {
		const testFixture = fixtureForTest();
		const settings = await testFixture.load(
			{ retry: { fallbackChains: [] } },
			{ retry: { fallbackChains: { smol: ["overlay/cheap"] } } },
		);

		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow"]);
		await settings.flush();

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ smol: ["overlay/cheap"], slow: ["user/slow"] });
		expect(await testFixture.readConfig()).toEqual({ retry: { fallbackChains: { slow: ["user/slow"] } } });
	});

	it("changes the persisted agent list by the toggled item only while an overlay supplies the list", async () => {
		const testFixture = fixtureForTest();
		const settings = await testFixture.load(
			{ task: { disabledAgents: ["reviewer"] } },
			{ task: { disabledAgents: ["scout"] } },
		);

		cfgTaskDisabledAgents.setMember(settings, "dev", { member: true });
		cfgTaskDisabledAgents.setMember(settings, "reviewer", { member: false });
		await settings.flush();

		expect(await testFixture.readConfig()).toEqual({ task: { disabledAgents: ["dev"] } });
	});
});
