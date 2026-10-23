import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(id: string, runEndPatch: string, releasePatch: string): Promise<number> {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
	tempRoots.push(artifactsDir);
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: "/repo/isolated",
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
		excludedPaths: [],
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
		branchName: `omp/task/${id}`,
		baseSha: "base",
		rootPatch: runEndPatch,
		nestedPatches: [],
	});
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${options.id}.jsonl`,
			status: "running",
		});
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			reviveSession: async () => session,
			onRelease: options.onRelease,
		});
		return result(options.id);
	});

	await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
		},
		context: { repoRoot: "/repo" },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "branch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	await AgentLifecycleManager.global().release(id);
	return commitSpy.mock.calls.length;
}

describe("isolated agent release", () => {
	const patch = "diff --git a/task.txt b/task.txt\n+work\n";

	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", patch, patch)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", patch, `${patch}+follow-up\n`)).toBe(2);
	});
});

describe("isolation allocation operation boundaries", () => {
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	const agent = { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" };

	it("serializes shared task/eval materialization while isolated agent bodies run in parallel", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-admission-"));
		tempRoots.push(artifactsDir);
		const firstSetupEntered = Promise.withResolvers<void>();
		const allowFirstSetup = Promise.withResolvers<void>();
		const bothBodiesStarted = Promise.withResolvers<void>();
		const releaseBodies = Promise.withResolvers<void>();
		let activeBodies = 0;
		let maxActiveBodies = 0;
		let activeAllocations = 0;
		let maxActiveAllocations = 0;
		let allocationTail = Promise.resolve();

		vi.spyOn(worktreeModule, "ensureIsolation").mockImplementation(async (_cwd, id) => {
			if (id === "serialized-first") {
				firstSetupEntered.resolve();
				await allowFirstSetup.promise;
			}
			return {
				mergedDir: `/repo/${id}`,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
				excludedPaths: [],
			};
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			activeBodies++;
			maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
			if (activeBodies === 2) bothBodiesStarted.resolve();
			await releaseBodies.promise;
			activeBodies--;
			return result(options.id);
		});
		const gate = async <T>(_operation: unknown, body: () => Promise<T>): Promise<T> => {
			const previous = allocationTail;
			const settled = Promise.withResolvers<void>();
			allocationTail = previous.then(() => settled.promise);
			await previous;
			activeAllocations++;
			maxActiveAllocations = Math.max(maxActiveAllocations, activeAllocations);
			try {
				return await body();
			} finally {
				activeAllocations--;
				settled.resolve();
			}
		};
		const run = (id: string) =>
			runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent,
					task: "Do work",
					index: 0,
					id,
					keepAlive: false,
					runIsolationOperation: gate,
				},
				context: { repoRoot: "/repo" },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "patch",
				artifactsDir,
				buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
			});

		const first = run("serialized-first");
		await firstSetupEntered.promise;
		const second = run("serialized-second");
		await Promise.resolve();
		expect(maxActiveAllocations).toBe(1);
		allowFirstSetup.resolve();
		await bothBodiesStarted.promise;
		expect(maxActiveBodies).toBe(2);
		expect(maxActiveAllocations).toBe(1);
		releaseBodies.resolve();
		await Promise.all([first, second]);
	});

	it("finishes failed setup cleanup before materialization admission releases", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-failed-setup-"));
		tempRoots.push(artifactsDir);
		const events: string[] = [];
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/failed-setup",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
			excludedPaths: [],
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockRejectedValue(new Error("baseline failed"));
		vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
			events.push("cleanup");
		});
		const gate = async <T>(operation: { kind: string }, body: () => Promise<T>): Promise<T> => {
			events.push(`enter:${operation.kind}`);
			try {
				return await body();
			} finally {
				events.push(`release:${operation.kind}`);
			}
		};

		const failed = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent,
				task: "Do work",
				index: 0,
				id: "failed-setup",
				keepAlive: false,
				runIsolationOperation: gate,
			},
			context: { repoRoot: "/repo" },
			preferredBackend: undefined,
			agentId: "failed-setup",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result("failed-setup"), exitCode: 1, error: String(error) }),
		});

		expect(failed.exitCode).toBe(1);
		expect(events.indexOf("cleanup")).toBeGreaterThan(events.indexOf("enter:materialize"));
		expect(events.indexOf("cleanup")).toBeLessThan(events.indexOf("release:materialize"));
	});

	it("releases admission while waiting for an AI branch message", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-cloud-message-"));
		tempRoots.push(artifactsDir);
		const cloudEntered = Promise.withResolvers<void>();
		const releaseCloud = Promise.withResolvers<void>();
		const secondMaterialized = Promise.withResolvers<void>();
		let allocationTail = Promise.resolve();

		vi.spyOn(worktreeModule, "ensureIsolation").mockImplementation(async (_cwd, id) => {
			if (id === "cloud-second") secondMaterialized.resolve();
			return {
				mergedDir: `/repo/${id}`,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
				excludedPaths: [],
			};
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		vi.spyOn(worktreeModule, "prepareCommitToBranch").mockResolvedValue({
			isolationDir: "/repo/cloud-first",
			repoRoot: "/repo",
			taskId: "cloud-first",
			branchName: "omp/task/cloud-first",
			baseSha: "base",
			rootPatch: "diff --git a/file b/file\n",
			nestedPatches: [],
			fallbackMessage: "cloud-first",
			fetchAgentHead: false,
			patches: [],
			messageDiffs: ["diff --git a/file b/file\n"],
		});
		vi.spyOn(worktreeModule, "finalizeCommitToBranch").mockResolvedValue({
			branchName: "omp/task/cloud-first",
			baseSha: "base",
			rootPatch: "diff --git a/file b/file\n",
			nestedPatches: [],
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => result(options.id));
		const gate = async <T>(_operation: unknown, body: () => Promise<T>): Promise<T> => {
			const previous = allocationTail;
			const settled = Promise.withResolvers<void>();
			allocationTail = previous.then(() => settled.promise);
			await previous;
			try {
				return await body();
			} finally {
				settled.resolve();
			}
		};
		const first = runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent,
				task: "Do work",
				index: 0,
				id: "cloud-first",
				keepAlive: false,
				runIsolationOperation: gate,
			},
			context: { repoRoot: "/repo" },
			preferredBackend: undefined,
			agentId: "cloud-first",
			mergeMode: "branch",
			artifactsDir,
			buildCommitMessage: () => async () => {
				cloudEntered.resolve();
				await releaseCloud.promise;
				return "chore: branch result";
			},
			buildFailureResult: error => ({ ...result("cloud-first"), exitCode: 1, error: String(error) }),
		});
		await cloudEntered.promise;
		const second = runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent,
				task: "Do work",
				index: 0,
				id: "cloud-second",
				keepAlive: false,
				runIsolationOperation: gate,
			},
			context: { repoRoot: "/repo" },
			preferredBackend: undefined,
			agentId: "cloud-second",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result("cloud-second"), exitCode: 1, error: String(error) }),
		});
		await secondMaterialized.promise;
		releaseCloud.resolve();
		await Promise.all([first, second]);
	});

	it("starts deferred teardown only after the child cleanup settles", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-deferred-cleanup-"));
		tempRoots.push(artifactsDir);
		const deferred = Promise.withResolvers<void>();
		const cleanupStarted = Promise.withResolvers<void>();
		const events: string[] = [];

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/deferred",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
			excludedPaths: [],
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
			events.push("cleanup");
			cleanupStarted.resolve();
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(deferred.promise);
			return { ...result(options.id), exitCode: 1 };
		});
		const gate = async <T>(operation: { kind: string }, body: () => Promise<T>): Promise<T> => {
			events.push(`gate:${operation.kind}`);
			return body();
		};

		await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent,
				task: "Do work",
				index: 0,
				id: "deferred-cleanup",
				keepAlive: false,
				onRelease: async () => {
					events.push("release-base");
				},
				runIsolationOperation: gate,
			},
			context: { repoRoot: "/repo" },
			preferredBackend: undefined,
			agentId: "deferred-cleanup",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result("deferred-cleanup"), exitCode: 1, error: String(error) }),
		});
		expect(events).not.toContain("cleanup");
		deferred.resolve();
		await cleanupStarted.promise;
		expect(events.indexOf("release-base")).toBeGreaterThan(-1);
		expect(events.indexOf("gate:cleanup")).toBeGreaterThan(events.indexOf("release-base"));
		expect(events.indexOf("cleanup")).toBeGreaterThan(events.indexOf("gate:cleanup"));
	});
});
