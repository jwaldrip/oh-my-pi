import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import { ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

describe("isolation persistence and recovery", () => {
	const tempRoots: string[] = [];
	let savedEnv: string | undefined;

	beforeEach(async () => {
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	function makeResult(id: string, exitCode = 0): SingleResult {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Do work",
			exitCode,
			output: exitCode === 0 ? "done" : "task failed",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
	}

	describe("failure and cancellation recovery", () => {
		it("recovers branch on failed task with changes and tears down workspace after verified recovery", async () => {
			const id = "FailRecoverBranch";
			const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-persist-"));
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
			});
			vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
			const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
				rootPatch: "diff --git a/f.txt b/f.txt\n+uncommitted\n",
				nestedPatches: [],
			});
			const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
				branchName: `omp/task/${id}`,
				baseSha: "base",
				rootPatch: "diff --git a/f.txt b/f.txt\n+uncommitted\n",
				nestedPatches: [],
			});

			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult(id, 1));

			const res = await runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent: { name: "task", description: "Task", systemPrompt: "test", source: "bundled" },
					task: "Do work",
					index: 0,
					id,
				},
				context: { repoRoot: "/repo" },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "branch",
				artifactsDir,
				buildFailureResult: err => ({ ...makeResult(id, 1), error: String(err) }),
			});

			expect(commitSpy).toHaveBeenCalled();
			expect(res.branchName).toBe(`omp/task/${id}`);
			expect(cleanupSpy).toHaveBeenCalled();
		});

		it("recovers patch on failed task with changes when mergeMode is patch", async () => {
			const id = "FailRecoverPatch";
			const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-persist-"));
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
			});
			vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
			const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
				rootPatch: "diff --git a/f.txt b/f.txt\n+patch-only\n",
				nestedPatches: [],
			});

			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult(id, 1));

			const res = await runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent: { name: "task", description: "Task", systemPrompt: "test", source: "bundled" },
					task: "Do work",
					index: 0,
					id,
				},
				context: { repoRoot: "/repo" },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "patch",
				artifactsDir,
				buildFailureResult: err => ({ ...makeResult(id, 1), error: String(err) }),
			});

			expect(res.patchPath).toBe(path.join(artifactsDir, `${id}.patch`));
			expect(cleanupSpy).toHaveBeenCalled();
		});

		it("retains accessible unique state when both branch and patch recovery fail", async () => {
			const id = "DoubleRecoveryFailure";
			const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-persist-"));
			tempRoots.push(artifactsDir);
			const isoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-merged-"));
			tempRoots.push(isoDir);
			const baseDir = path.dirname(isoDir);
			const baseline = {
				root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
				nested: [],
			};

			vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
				mergedDir: isoDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			});
			vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
			const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
				rootPatch: "diff --git a/f.txt b/f.txt\n+cannot-commit\n",
				nestedPatches: [],
			});
			vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("git commit failure"));
			vi.spyOn(Bun, "write").mockRejectedValue(new Error("disk full cannot write patch"));

			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult(id, 1));

			const res = await runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent: { name: "task", description: "Task", systemPrompt: "test", source: "bundled" },
					task: "Do work",
					index: 0,
					id,
				},
				context: { repoRoot: "/repo" },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "branch",
				artifactsDir,
				buildFailureResult: err => ({ ...makeResult(id, 1), error: String(err) }),
			});

			// Cleanup must NOT have run: workspace retained!
			expect(cleanupSpy).not.toHaveBeenCalled();
			expect(res.error).toBeDefined();
			expect(res.error).toContain("retained");
		});

		it("recovers branch work when subprocess aborts or throws", async () => {
			const id = "CancelledSubprocess";
			const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-persist-"));
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
			});
			vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
			const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
				rootPatch: "diff --git a/f.txt b/f.txt\n+interrupted\n",
				nestedPatches: [],
			});
			vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
				branchName: `omp/task/${id}`,
				baseSha: "base",
				rootPatch: "diff --git a/f.txt b/f.txt\n+interrupted\n",
				nestedPatches: [],
			});

			vi.spyOn(executorModule, "runSubprocess").mockRejectedValue(new Error("Task aborted"));

			const res = await runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent: { name: "task", description: "Task", systemPrompt: "test", source: "bundled" },
					task: "Do work",
					index: 0,
					id,
				},
				context: { repoRoot: "/repo" },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "branch",
				artifactsDir,
				buildFailureResult: err => ({ ...makeResult(id, 1), error: String(err) }),
			});

			expect(res.branchName).toBe(`omp/task/${id}`);
			expect(cleanupSpy).toHaveBeenCalled();
		});
	});

	describe("reusable-id safety", () => {
		it("rejects overwriting an occupied preexisting isolation base dir", async () => {
			const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-occupied-"));
			tempRoots.push(base);
			setWorktreesDir(base);

			const fakeRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-repo-"));
			tempRoots.push(fakeRepo);
			// Initialize a minimal git directory so getRepoRoot succeeds
			await fs.mkdir(path.join(fakeRepo, ".git"), { recursive: true });
			await fs.writeFile(path.join(fakeRepo, ".git", "HEAD"), "ref: refs/heads/main\n");

			// Pre-create the deterministic task isolation dir with content
			const taskId = "reusable-task-1";
			// Compute what ensureIsolation will use
			const key = `${path.resolve(fakeRepo)}\0${taskId}`;
			const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-9);
			const expectedBaseDir = path.join(base, `t${digest}`);
			await fs.mkdir(expectedBaseDir, { recursive: true });
			await fs.writeFile(path.join(expectedBaseDir, "valuable-state.txt"), "must not be deleted\n");

			await expect(ensureIsolation(fakeRepo, taskId)).rejects.toThrow("already exists and is occupied");

			// Verify the occupied file was untouched
			expect(await Bun.file(path.join(expectedBaseDir, "valuable-state.txt")).text()).toBe("must not be deleted\n");
		});
	});

	describe("dependent Git store preservation in CLI cleanup", () => {
		it("preserves Git stores and linked worktree stores even with clearWorktrees all: true", async () => {
			const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-cli-"));
			tempRoots.push(wtBase);
			setWorktreesDir(wtBase);

			// 1. Standard repo with .git directory and registered worktrees (like t6402fcf88)
			const commonStore = path.join(wtBase, "t6402fcf88");
			await fs.mkdir(path.join(commonStore, ".git", "worktrees", "linked-1"), { recursive: true });
			await fs.writeFile(path.join(commonStore, ".git", "HEAD"), "ref: refs/heads/main\n");
			await fs.writeFile(path.join(commonStore, ".git", "worktrees", "linked-1", "gitdir"), "/some/path\n");

			// 2. Bare repo Git store
			const bareStore = path.join(wtBase, "bare-store");
			await fs.mkdir(path.join(bareStore, "objects"), { recursive: true });
			await fs.mkdir(path.join(bareStore, "refs"), { recursive: true });
			await fs.mkdir(path.join(bareStore, "worktrees", "wt-child"), { recursive: true });
			await fs.writeFile(path.join(bareStore, "HEAD"), "ref: refs/heads/main\n");

			// 3. Normal stray directory without git store (should be removed)
			const strayDir = path.join(wtBase, "stray-rubbish");
			await fs.mkdir(strayDir, { recursive: true });
			await fs.writeFile(path.join(strayDir, "temp.txt"), "junk\n");

			// Run clearWorktrees with all: true
			await clearWorktrees({ all: true, dryRun: false, json: true });

			// Dependent Git stores MUST be preserved!
			expect(await fs.stat(commonStore).then(() => true, () => false)).toBe(true);
			expect(await fs.stat(bareStore).then(() => true, () => false)).toBe(true);
			// Stray non-git directory should be removed
			expect(await fs.stat(strayDir).then(() => true, () => false)).toBe(false);
		});
	});
});
