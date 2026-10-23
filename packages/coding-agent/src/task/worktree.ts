import { type NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { VcsCommitAuthor, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, getWorktreeDir, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { SettingValueOf } from "../config/registry";

import { withRepoLock } from "../utils/repo-lock";
import { needsNativeTeardown, writeIsolationOwner, writeRetainedBackend } from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";
import type { cfgIsolationBackend } from "./settings";

const { IsoBackendKind } = natives;

const TASK_ISOLATION_DIR_PREFIX = "t";
const TASK_ISOLATION_DIR_DIGEST_CHARS = 9;
const TASK_ISOLATION_MOUNT_DIR = "m";
const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
type IsoBackendKind = natives.IsoBackendKind;
/**
 * A native isolation backend may have allocated resources even though setup or
 * teardown rejected. Its owner marker and backend sidecar are intentionally
 * retained for the external reclaimer rather than being removed optimistically.
 */
export class IsolationTeardownUnresolvedError extends Error {
	readonly unresolvedIsolation = true;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "IsolationTeardownUnresolvedError";
	}
}

export function isIsolationTeardownUnresolved(error: unknown): error is IsolationTeardownUnresolvedError {
	return error instanceof IsolationTeardownUnresolvedError;
}

function aggregateError(message: string, errors: unknown[]): Error {
	const present = errors.filter((error): error is Error => error instanceof Error);
	if (present.length === 1) return present[0];
	return new AggregateError(errors, message);
}

async function diffTreeOrEmpty(repo: VcsGitRepo, base: string, head: string): Promise<string> {
	try {
		return await repo.diffTree(base, head, true);
	} catch (error) {
		if (vcs.isVcsError(error)) return "";
		throw error;
	}
}

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	// Pure-jj check runs first so a jj workspace nested under an unrelated
	// outer Git checkout is rejected at its own root rather than silently
	// mutating the surrounding Git tree behind jj's back.
	if (vcs.isPureJj(cwd)) {
		throw new Error(
			"Isolated task execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `task.isolation.enabled: false` to disable task isolation.",
		);
	}

	const repoRoot = vcs.git(cwd)?.info().repoRoot;
	if (repoRoot) return repoRoot;

	throw new Error("Git repository not found for isolated task execution.");
}

const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

/** Real path of the git common dir owning `dir`, or `undefined` outside any repo. */
async function realCommonDir(dir: string): Promise<string | undefined> {
	const commonDir = vcs.gitInfo(dir)?.commonDir;
	if (!commonDir) return undefined;
	// git writes realpath'd admin pointers; match them across symlinked
	// prefixes (macOS /var -> /private/var).
	return fs.realpath(commonDir).catch(() => path.resolve(commonDir));
}

function normalizedRelativePath(root: string, target: string): string | undefined {
	const relative = path.relative(root, target);
	if (
		relative.length === 0 ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return undefined;
	}
	return relative.split(path.sep).join("/");
}

function isSameOrDescendant(relativePath: string, ancestor: string): boolean {
	return relativePath === ancestor || relativePath.startsWith(`${ancestor}/`);
}
async function canonicalPath(value: string): Promise<string> {
	return fs.realpath(value).catch(() => path.resolve(value));
}

async function canonicalOrigin(remote: string, repoRoot: string): Promise<string | undefined> {
	const value = remote.trim();
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === "file:") {
			return `file:${await canonicalPath(fileURLToPath(url))}`;
		}
		if (url.hostname) {
			const remotePath = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
			return remotePath ? `remote:${url.host.toLowerCase()}/${remotePath}` : undefined;
		}
	} catch {
		// A local path or scp-style Git URL is not a WHATWG URL.
	}
	if (path.isAbsolute(value) || value.startsWith(".")) {
		return `file:${await canonicalPath(path.resolve(repoRoot, value))}`;
	}
	const scp = value.match(/^(?:[^@:\s]+@)?([^:/\s]+):(.+)$/);
	if (scp) {
		const remotePath = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return remotePath ? `remote:${scp[1].toLowerCase()}/${remotePath}` : undefined;
	}
	return `literal:${value}`;
}

async function sharesVerifiedOriginAndAncestry(source: VcsGitRepo, candidate: VcsGitRepo): Promise<boolean> {
	try {
		const [sourceOrigin, candidateOrigin, sourceHead, candidateHead] = await Promise.all([
			source.remoteUrl("origin"),
			candidate.remoteUrl("origin"),
			source.headSha(),
			candidate.headSha(),
		]);
		if (!sourceOrigin || !candidateOrigin || !sourceHead || !candidateHead) return false;
		const [sourceIdentity, candidateIdentity] = await Promise.all([
			canonicalOrigin(sourceOrigin, source.info().repoRoot),
			canonicalOrigin(candidateOrigin, candidate.info().repoRoot),
		]);
		if (!sourceIdentity || sourceIdentity !== candidateIdentity) return false;
		if (sourceHead === candidateHead) return true;
		return (await source.mergeBase(sourceHead, candidateHead)) != null;
	} catch {
		// A shallow, malformed, or unrelated candidate cannot prove identity.
		return false;
	}
}

async function isOuterIgnored(repoRoot: string, relativePath: string): Promise<boolean> {
	try {
		const child = Bun.spawn(["git", "-C", repoRoot, "check-ignore", "--quiet", "--", relativePath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await child.exited) === 0;
	} catch {
		// Absence of a trustworthy ignore verdict preserves the candidate.
		return false;
	}
}

/**
 * Build one conservative exclusion plan for both materialization and baseline
 * discovery. A nested checkout is omitted only when the outer repository
 * ignores it, tracks nothing at or beneath it, it is not a declared
 * submodule/gitlink, and its Git metadata proves it belongs to this source.
 */
export async function prepareIsolationCopyPlan(repoRoot: string): Promise<readonly string[]> {
	const source = vcs.requireGit(repoRoot);
	const sourceRoot = await canonicalPath(source.info().repoRoot);
	const sourceCommonDir = await realCommonDir(sourceRoot);
	const [trackedPaths, submodulePaths] = await Promise.all([source.lsFiles(false, false), source.submodulePaths()]);
	const normalizedSubmodules = submodulePaths.map(submodule => submodule.replaceAll("\\", "/"));
	const excluded: string[] = [];

	async function shouldExclude(full: string, relativePath: string): Promise<boolean> {
		if (normalizedSubmodules.some(submodule => isSameOrDescendant(relativePath, submodule))) return false;
		if (trackedPaths.some(tracked => isSameOrDescendant(tracked, relativePath))) return false;
		if (!(await isOuterIgnored(sourceRoot, relativePath))) return false;
		try {
			const candidate = vcs.git(full);
			if (!candidate) return false;
			const [candidateRoot, actualPath] = await Promise.all([
				canonicalPath(candidate.info().repoRoot),
				canonicalPath(full),
			]);
			if (candidateRoot !== actualPath) return false;
			const candidateCommonDir = await realCommonDir(candidateRoot);
			if (sourceCommonDir && candidateCommonDir === sourceCommonDir) return true;
			return sharesVerifiedOriginAndAncestry(source, candidate);
		} catch {
			// Metadata that cannot be read is unknown identity, not a deletion
			// target.
			return false;
		}
	}

	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// Dependencies are ordinary runtime input, not candidate sandbox
			// repositories. Never broaden an exclusion plan by inspecting them.
			if (entry.name === ".git" || entry.name === "node_modules" || !entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const relativePath = normalizedRelativePath(sourceRoot, full);
			if (!relativePath) continue;
			if (normalizedSubmodules.some(submodule => isSameOrDescendant(relativePath, submodule))) continue;
			let nestedRepository: boolean;
			try {
				nestedRepository = await hasGitEntry(full);
			} catch {
				// Unknown metadata preserves this subtree without inspecting it.
				continue;
			}
			if (nestedRepository) {
				if (await shouldExclude(full, relativePath)) excluded.push(relativePath);
				// A nested checkout owns its own subtree. Preserve it or omit it
				// as one unit, never inspect its runtime files through the outer
				// repository's ignore rules.
				continue;
			}
			await walk(full);
		}
	}

	await walk(sourceRoot);
	return excluded.sort();
}

/**
 * Find nested git repositories (non-submodule) under `repoRoot`.
 *
 * A directory whose common dir belongs to one of `ownRepos` is a linked
 * worktree of the same repository, not a nested repo, and is skipped with
 * everything under it. A copied isolation carries every in-tree linked
 * worktree (e.g. gitignored `.claude/worktrees/*`) whose `.git` pointer still
 * targets the source checkout's admin dir; baselining each one re-hashes its
 * whole tree against a foreign index and froze the host (#16068).
 */
async function discoverNestedRepos(
	repoRoot: string,
	ownRepos: readonly string[],
	excludedPaths: readonly string[] = [],
): Promise<string[]> {
	const submodulePaths = (await vcs.requireGit(repoRoot).submodulePaths()).map(submodule =>
		submodule.replaceAll("\\", "/"),
	);
	const ownCommonDirs = new Set(
		(await Promise.all(ownRepos.map(realCommonDir))).filter((dir): dir is string => dir !== undefined),
	);

	// Find all .git dirs/files that aren't the root, known submodules, or a
	// subtree already excluded from the materialization plan.
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git" || !entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const relativePath = normalizedRelativePath(repoRoot, full);
			if (!relativePath) continue;
			if (excludedPaths.some(excluded => isSameOrDescendant(relativePath, excluded))) continue;
			if (submodulePaths.some(submodule => isSameOrDescendant(relativePath, submodule))) continue;
			if (await hasGitEntry(full)) {
				const commonDir = await realCommonDir(full);
				if (commonDir && ownCommonDirs.has(commonDir)) continue;
				result.push(path.relative(repoRoot, full));
				// Don't recurse into nested repos — they manage their own tree.
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

/**
 * Ceiling on the working-tree content a single repo baseline may buffer in
 * memory. Baseline capture embeds every uncommitted byte — staged/unstaged
 * binary diffs plus a `--no-index` binary diff of each untracked file — into
 * in-memory strings (see {@link captureUntrackedPatch}). A binary diff is
 * ~1.3x the raw bytes, so a multi-GB working tree produces a single string
 * that blows past the engine's string limit and the process's memory, taking
 * the whole host down (issue #8939). `git ls-files --others
 * --exclude-standard` already omits gitignored bulk, so this only trips on
 * pathological non-ignored content; when it does we refuse the isolated spawn
 * with an actionable error instead of trapping the host.
 *
 * The staged and unstaged diffs are rendered under this budget inside the
 * native renderer (`diffText({ maxBytes })`): their size is unknowable before
 * rendering and can dwarf the working tree itself (index-vs-HEAD of a jj
 * conflict commit exported to git spans every conflict side), so the cap has
 * to stop the renderer rather than measure its output afterwards. The budget
 * bounds content, not RSS: a patch is briefly held twice while it crosses the
 * native boundary, and each nested repo is captured against its own budget.
 */
export const ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1024 * 1024 * 1024;

/**
 * Thrown when a repo's uncommitted content exceeds the isolation-snapshot
 * budget. Surfaced verbatim so the caller can report the real cause
 * (oversized working tree) rather than masking it as a missing git repository.
 *
 * `contentBytes` is the measured total when the untracked stat pass tripped
 * the budget, and `undefined` when a staged or unstaged diff crossed it while
 * rendering — the renderer stops at the cap, so the full size is unknown.
 */
export class IsolationBaselineTooLargeError extends Error {
	constructor(
		readonly repoRoot: string,
		readonly contentBytes: number | undefined,
		readonly budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	) {
		const measured =
			contentBytes === undefined
				? `more than ${formatBytes(budgetBytes)} of uncommitted content`
				: `${formatBytes(contentBytes)} of uncommitted content, over the ${formatBytes(budgetBytes)} isolation-snapshot budget`;
		super(
			`Working tree at ${repoRoot} carries ${measured}. ` +
				`Isolated task snapshots buffer this content in memory, so proceeding would exhaust the host. ` +
				`Commit or gitignore the bulk (untracked files that aren't ignored are the usual culprit), ` +
				`or set \`task.isolation.enabled: false\` to run tasks without isolation.`,
		);
		this.name = "IsolationBaselineTooLargeError";
	}
}

/** Sum untracked entry sizes without following symlinks, skipping entries that vanished. */
async function sumUntrackedBytes(repoRoot: string, untracked: readonly string[]): Promise<number> {
	if (untracked.length === 0) return 0;
	const { results } = await mapWithConcurrencyLimit([...untracked], 16, async entry => {
		try {
			const stat = await fs.lstat(path.join(repoRoot, entry));
			return stat.isFile() ? stat.size : 0;
		} catch {
			return 0;
		}
	});
	return results.reduce((total: number, size) => total + (size ?? 0), 0);
}

async function captureUntrackedPatch(
	repoRoot: string,
	untracked: readonly string[],
	repo: VcsGitRepo = vcs.requireGit(repoRoot),
): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent native encodes so large untracked sets do not hold every
	// file and binary patch in memory at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, async entry => {
		try {
			return await repo.diffNoIndex(nullPath, entry, true);
		} catch (error) {
			if (vcs.isVcsError(error)) return "";
			throw error;
		}
	});
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
}

/**
 * Capture a repo's pre-spawn baseline: head, staged and unstaged binary diffs,
 * and the untracked-file patch, keeping the buffered content under
 * `budgetBytes`. The two diffs are rendered natively under the remaining
 * budget, so an oversized change set fails inside the renderer instead of
 * after the whole patch is in memory.
 */
async function captureRepoBaseline(repoRoot: string, budgetBytes: number): Promise<RepoBaseline> {
	const repo = vcs.requireGit(repoRoot);
	const headCommit = (await repo.headSha()) ?? "";
	let staged: string;
	let unstaged: string;
	try {
		staged = await repo.diffText({ binary: true, cached: true, maxBytes: budgetBytes });
		// The renderer's cap and the budget are UTF-8 bytes; a render that
		// succeeded is at most `budgetBytes` of them, so the remainder is never
		// negative.
		unstaged = await repo.diffText({ binary: true, maxBytes: budgetBytes - Buffer.byteLength(staged) });
	} catch (error) {
		if (vcs.isVcsError(error) && error.code === "OutputTooLarge") {
			throw new IsolationBaselineTooLargeError(repoRoot, undefined, budgetBytes);
		}
		throw error;
	}
	const untracked = await repo.lsFiles(true, true);
	// Gate before capturing the untracked patch: that step embeds every
	// untracked byte into one in-memory string, so an oversized tree must be
	// refused here rather than after buffering gigabytes (#8939). Untracked
	// bytes come from stat (no reads); staged/unstaged are already rendered
	// binary diffs, charged at their byte size.
	const untrackedBytes = await sumUntrackedBytes(repoRoot, untracked);
	const contentBytes = untrackedBytes + Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
	if (contentBytes > budgetBytes) {
		throw new IsolationBaselineTooLargeError(repoRoot, contentBytes, budgetBytes);
	}
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked, repo);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

interface SyntheticTreeOptions {
	readonly threeWay?: boolean;
}

async function writeSyntheticTree(
	repoDir: string,
	baseTreeish: string,
	patches: readonly string[],
	options: SyntheticTreeOptions = {},
): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	const repo = vcs.requireGit(repoDir);
	try {
		await repo.readTree(baseTreeish, tempIndex);
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await repo.applyPatch(patch, {
				cached: true,
				indexPath: tempIndex,
				threeWay: options.threeWay,
			});
		}
		return await repo.writeTree(tempIndex);
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

/**
 * Capture the baseline of `repoRoot` and every nested repo under it. Each repo
 * baseline may buffer at most `budgetBytes` of uncommitted content (the
 * isolation-snapshot budget, {@link ISOLATION_BASELINE_MAX_CONTENT_BYTES}).
 * Linked worktrees of any repo in `ownRepos` and subtrees in `excludedPaths`
 * are not nested repos (see {@link discoverNestedRepos}).
 */
export async function captureBaseline(
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	ownRepos: readonly string[] = [repoRoot],
	excludedPaths: readonly string[] = [],
): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([
		captureRepoBaseline(repoRoot, budgetBytes),
		discoverNestedRepos(repoRoot, ownRepos, excludedPaths),
	]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath), budgetBytes),
		})),
	);
	return { root, nested };
}

/**
 * Capture the baseline of a freshly materialised isolation and rebind it to
 * the parent checkout at `repoRoot`.
 *
 * The isolation is a point-in-time copy of the parent's working tree, so its
 * own state is the only exact baseline: a baseline read from the live parent
 * before or after the copy also absorbs whatever other agents or merges wrote
 * in between, and that drift would surface as this task's changes.
 *
 * Copied linked worktrees may point at either the isolation's or the parent's
 * admin dir, so both count as the root repository.
 */
export async function captureIsolationBaseline(
	isolationDir: string,
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	excludedPaths: readonly string[] = [],
): Promise<WorktreeBaseline> {
	const { root, nested } = await captureBaseline(isolationDir, budgetBytes, [isolationDir, repoRoot], excludedPaths);
	return {
		root: { ...root, repoRoot },
		nested: nested.map(({ relativePath, baseline }) => ({
			relativePath,
			baseline: { ...baseline, repoRoot: path.join(repoRoot, relativePath) },
		})),
	};
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline, objectRepoDir = repoDir): Promise<string> {
	const repo = vcs.requireGit(repoDir);
	const objectRepo = objectRepoDir === repoDir ? repo : vcs.requireGit(objectRepoDir);
	const currentHead = (await repo.headSha()) ?? "";
	const currentStaged = await repo.diffText({ binary: true, cached: true });
	const currentUnstaged = await repo.diffText({ binary: true });
	const currentUntracked = await repo.lsFiles(true, true);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked, repo);
	const committedPatch =
		currentHead && currentHead !== rb.headCommit ? await diffTreeOrEmpty(repo, rb.headCommit, currentHead) : "";

	const baselineTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		rb.staged,
		rb.unstaged,
		rb.untrackedPatch,
	]);
	const currentTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		committedPatch,
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return diffTreeOrEmpty(objectRepo, baselineTree, currentTree);
}

function unquoteGitDiffPath(rawPath: string): string {
	let value = rawPath;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/^[ab]\//, "");
}

function parseDiffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const quoted = rest.match(/^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/);
	const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
	if (parts.length < 2) return [];
	const paths = parts
		.slice(0, 2)
		.map(unquoteGitDiffPath)
		.filter(file => file && file !== "/dev/null");
	return [...new Set(paths)];
}

function patchTouchedFiles(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		for (const file of parseDiffGitLinePaths(line)) files.add(file);
	}
	return [...files];
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

async function hasGitEntry(dir: string): Promise<boolean> {
	try {
		await fs.lstat(path.join(dir, ".git"));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	// Synthetic tree construction may read a new gitlink commit before the
	// root patch exists. Keep isolation-local objects in the source ODB first;
	// this does not change its refs, HEAD, or index. Submodules added inside
	// the isolation have no source checkout or `modules/<name>` admin dir (a
	// patch apply never creates one), so their objects go to the source root
	// ODB — the only store that survives isolation cleanup.
	const sourceRoot = baseline.root.repoRoot;
	const relativePaths = new Set([
		...(await vcs.requireGit(sourceRoot).submodulePaths()),
		...(await vcs.requireGit(isolationDir).submodulePaths()),
	]);
	for (const relativePath of relativePaths) {
		const isolatedDir = path.join(isolationDir, relativePath);
		const sourceDir = path.join(sourceRoot, relativePath);
		if (!(await hasGitEntry(isolatedDir))) continue;
		await vcs.copyGitObjects(isolatedDir, (await hasGitEntry(sourceDir)) ? sourceDir : sourceRoot);
	}
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb, nb.repoRoot);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/**
 * One AI commit-message request for a nested repository. The diff is captured
 * before the cloud call so callers can release host admission while waiting.
 */
export interface NestedPatchCommitMessageInput {
	relativePath: string;
	diff: string;
}

function groupNestedPatches(patches: readonly NestedRepoPatch[]): Map<string, NestedRepoPatch[]> {
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const patch of patches) {
		if (!patch.patch.trim()) continue;
		const group = byRepo.get(patch.relativePath) ?? [];
		group.push(patch);
		byRepo.set(patch.relativePath, group);
	}
	return byRepo;
}

/**
 * Collect every diff that can require an AI commit message without entering a
 * target repository. The caller can perform those cloud waits outside the
 * local allocation operation, then pass the settled messages to
 * {@link applyNestedPatchesWithMessages}.
 */
export function collectNestedPatchCommitMessageInputs(
	patches: readonly NestedRepoPatch[],
): NestedPatchCommitMessageInput[] {
	return [...groupNestedPatches(patches)].map(([relativePath, repoPatches]) => ({
		relativePath,
		diff: repoPatches.map(patch => patch.patch).join("\n"),
	}));
}

/**
 * Apply nested repo patches using messages already resolved by the caller.
 * This function performs no cloud work: every filesystem and Git mutation is
 * local so it can run wholly inside an allocation operation.
 */
export async function applyNestedPatchesWithMessages(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessages: ReadonlyMap<string, string | null | undefined> = new Map(),
): Promise<string[]> {
	const warnings: string[] = [];
	for (const [relativePath, repoPatches] of groupNestedPatches(patches)) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const repository = vcs.requireGit(nestedDir);
		const touchedFiles = [...new Set(repoPatches.flatMap(patch => patchTouchedFiles(patch.patch)))];
		const stashed = (await repository.isDirty())
			? await repository.stashPush(`omp-isolation-${Snowflake.next()}`)
			: false;
		try {
			for (const { patch } of repoPatches) {
				await repository.applyPatch(patch, {});
			}
			if (await repository.isDirty()) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const message = commitMessages.get(relativePath) ?? "changes from isolated task(s)";
				await repository.stageFiles(touchedFiles);
				await repository.commitCreate(message, {});
			}
		} finally {
			if (stashed) {
				const restored = await repository.stashTryPop(true).catch(() => false);
				if (!restored) {
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved.`,
					);
				}
			}
		}
	}
	return warnings;
}

/**
 * Compatibility wrapper for direct callers. Task isolation resolves
 * `commitMessage` before entering its local operation and calls
 * {@link applyNestedPatchesWithMessages} directly.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<string[]> {
	const messages = new Map<string, string | null | undefined>();
	if (commitMessage) {
		for (const { relativePath, diff } of collectNestedPatchCommitMessageInputs(patches)) {
			messages.set(relativePath, await commitMessage(diff));
		}
	}
	return applyNestedPatchesWithMessages(repoRoot, patches, messages);
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified isolation lifecycle — picks the best backend via the PAL and
// returns the merged-view path together with the resolved kind.
// ═══════════════════════════════════════════════════════════════════════════

/** User-facing backend names exposed by the `isolation.backend` setting. */
export type IsolationBackendSetting = SettingValueOf<typeof cfgIsolationBackend>;

/**
 * Translate an {@link IsolationBackendSetting} to the native backend hint.
 * `"auto"` returns `undefined`, allowing the PAL resolver to pick.
 */
export function parseIsolationBackend(backend: IsolationBackendSetting): IsoBackendKind | undefined {
	switch (backend) {
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
			return IsoBackendKind.Overlayfs;
		case "projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
			return IsoBackendKind.Rcopy;
	}
}

/** Return the canonical setting label for a resolved native backend. */
export function formatIsolationBackend(backend: IsoBackendKind): Exclude<IsolationBackendSetting, "auto"> {
	switch (backend) {
		case IsoBackendKind.Apfs:
			return "apfs";
		case IsoBackendKind.Btrfs:
			return "btrfs";
		case IsoBackendKind.Zfs:
			return "zfs";
		case IsoBackendKind.LinuxReflink:
			return "reflink";
		case IsoBackendKind.Overlayfs:
			return "overlayfs";
		case IsoBackendKind.Projfs:
			return "projfs";
		case IsoBackendKind.WindowsBlockClone:
			return "block-clone";
		case IsoBackendKind.Rcopy:
			return "rcopy";
	}
}

export interface IsolationHandle {
	/** Merged view materialised by the backend; pass this to the task. */
	mergedDir: string;
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
	/** Exact source-copy plan reused by post-materialization baseline discovery. */
	excludedPaths: readonly string[];
}

/**
 * Materialise `merged` for a single task. `preferred` is a hint — when
 * its prerequisites are missing the PAL silently falls back, and the
 * caller learns about that through `IsolationHandle.fellBack` +
 * `fallbackReason`.
 */

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-TASK_ISOLATION_DIR_DIGEST_CHARS);
	return `${TASK_ISOLATION_DIR_PREFIX}${digest}`;
}

/**
 * Submodule pointers in copied checkouts may target the source admin directory
 * or one under the root `.git` that detach removes. Materialize missing trees
 * from parents down, then detach admin state from leaves up.
 */
async function detachSubmodules(sourceRoot: string, isolationRoot: string): Promise<void> {
	const paths = await vcs.requireGit(sourceRoot).submodulePaths();
	const initialized: Array<{ sourceDir: string; isolatedDir: string; isFile: boolean }> = [];
	for (const relativePath of paths) {
		const sourceDir = path.join(sourceRoot, relativePath);
		const isolatedDir = path.join(isolationRoot, relativePath);
		try {
			await fs.lstat(path.join(sourceDir, ".git"));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		let isolatedEntry;
		try {
			isolatedEntry = await fs.lstat(path.join(isolatedDir, ".git"));
		} catch (error) {
			if (!isEnoent(error)) throw error;
			// `git worktree add` (rcopy) checks out gitlinks but not their trees.
			await fs.cp(sourceDir, isolatedDir, { recursive: true });
			isolatedEntry = await fs.lstat(path.join(isolatedDir, ".git"));
		}
		initialized.push({ sourceDir, isolatedDir, isFile: isolatedEntry.isFile() });
	}
	for (const { sourceDir, isolatedDir, isFile } of initialized.reverse()) {
		if (!isFile) continue;
		const info = vcs.requireGit(sourceDir).info();
		// A relative pointer into the copied root `.git/modules` becomes
		// dangling after root detach; read from the source until detached.
		await fs.writeFile(path.join(isolatedDir, ".git"), `gitdir: ${info.gitDir}\n`);
		await vcs.detachGitDir(isolatedDir, info.commonDir);
	}
}

async function retainUnresolvedIsolation(
	baseDir: string,
	backend: IsoBackendKind,
	message: string,
	errors: unknown[],
): Promise<never> {
	const metadataErrors: unknown[] = [];
	if (needsNativeTeardown(backend)) {
		try {
			await writeRetainedBackend(baseDir, backend);
		} catch (error) {
			metadataErrors.push(error);
		}
	}
	throw new IsolationTeardownUnresolvedError(
		`${message}; retaining isolation ownership at ${baseDir} for explicit teardown.`,
		{ cause: aggregateError(message, [...errors, ...metadataErrors]) },
	);
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const sourceCommonDir = vcs.requireGit(repoRoot).info().commonDir;
	const excludedPaths = await prepareIsolationCopyPlan(repoRoot);
	const baseDir = getWorktreeDir(getTaskIsolationSegment(repoRoot, id));
	const mergedDir = path.join(baseDir, TASK_ISOLATION_MOUNT_DIR);
	const resolution = await natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		// Claim ownership before the backend materialises `m`. Backends only
		// create/replace `mergedDir` (and overlay upper/work), never the base
		// dir, so the marker survives `isoStart` — and a concurrent
		// `omp worktree clear` never sees this sandbox without a live owner,
		// even while a large clone is still in progress.
		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, id);
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir, [...excludedPaths]);
			// Sever the isolation's git metadata from the source checkout. Copy
			// backends duplicate `repoRoot`'s `.git` verbatim — a linked-worktree
			// pointer file (or the rcopy `git worktree add` registration) leaves
			// the isolation sharing the source's HEAD/index/ref namespace, so a
			// task's git operations would mutate the parent checkout and stack
			// parallel task branches. Detaching gives each isolation a private,
			// frozen repo that still borrows the source object DB via alternates.
			await detachSubmodules(repoRoot, mergedDir);
			await vcs.detachGitDir(mergedDir, sourceCommonDir);
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
				excludedPaths,
			};
		} catch (error) {
			const message = errorMessage(error);
			const unavailable = natives.isoIsUnavailableError(message);
			try {
				// `isoStart` may fail after a backend has created its mount,
				// clone, or copy destination. Stop positively before touching
				// the ownership directory, including an unavailable candidate.
				await natives.isoStop(candidate, mergedDir);
			} catch (teardownError) {
				await retainUnresolvedIsolation(baseDir, candidate, "isolation setup teardown failed", [error, teardownError]);
			}
			try {
				await fs.rm(baseDir, { recursive: true, force: true });
			} catch (removeError) {
				throw new Error(`isolation setup stopped its backend but could not remove ${baseDir}`, {
					cause: aggregateError("isolation setup cleanup failed", [error, removeError]),
				});
			}
			if (unavailable) {
				fallbackReason ??= message;
				continue;
			}
			throw error;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Tear down a handle returned by {@link ensureIsolation}. */
export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	const baseDir = path.dirname(handle.mergedDir);
	try {
		await natives.isoStop(handle.backend, handle.mergedDir);
	} catch (error) {
		await retainUnresolvedIsolation(baseDir, handle.backend, "isolation backend stop failed during cleanup", [error]);
	}
	await fs.rm(baseDir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	/** Root delta the branch was built from; lets callers detect whether a later capture changed anything. */
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	/**
	 * SHA of the parent-repo commit the task branch was created on top of, so
	 * {@link mergeTaskBranches} can cherry-pick the range `baseSha..branchName`
	 * and preserve every agent commit's message and author.
	 */
	baseSha?: string;
}

function baselineHasRootWip(baseline: RepoBaseline): boolean {
	return !!(baseline.staged.trim() || baseline.unstaged.trim() || baseline.untrackedPatch.trim());
}

/**
 * Baseline WIP context needed to safely apply a delta patch whose hunks were
 * captured against `HEAD + WIP` (see {@link captureRepoDeltaPatch}). Passed
 * whenever {@link baselineHasRootWip} is true so {@link patchTree} can replay
 * the WIP first, then rewind WIP-only files after applying the delta.
 */
interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

/** Keep only the `diff --git` sections of `patch` that touch one of `files`. */
function filterPatchFiles(patch: string, files: ReadonlySet<string>): string {
	const sections = patch.split(/^(?=diff --git )/m);
	return sections.filter(section => parseDiffGitLinePaths(section.split("\n", 1)[0]).some(f => files.has(f))).join("");
}

/**
 * Resolve the tree `parentSha + patchText` in `repoDir` through a temporary
 * index — no checkout, so nothing lingers on disk if the process dies.
 *
 * Tries the two clean paths first; both yield an agent-only tree:
 *   1. Plain apply — works when the WIP context matches the parent.
 *   2. `--3way` — works when the WIP-side blob is tracked and in the ODB
 *      (captureDeltaPatch seeded it while writing the synthetic baseline
 *      tree); the 3-way merge subtracts the WIP.
 *
 * If both fail (untracked WIP files, staged-new WIP files, or overlap that
 * --3way can't resolve — see #4136), replay the WIP first so the delta's
 * context lines match, then rewind WIP-only files to the parent. Files touched
 * by BOTH WIP and delta keep their combined state; merge-back reconciles the
 * WIP side because the cherry-pick refuses to overwrite dirty paths.
 */
async function patchTree(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	let plainErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText]);
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		plainErr = err;
	}
	let threeWayErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText], { threeWay: true });
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		threeWayErr = err;
	}
	const wipPatches = collectWipPatches(baselineWip);
	const logContext = {
		taskId,
		threeWayStderr: threeWayErr.stderr.slice(0, 2000),
		initialStderr: plainErr.stderr.slice(0, 2000),
		patchSize: patchText.length,
		patchHead: patchText.slice(0, 500),
	};
	if (wipPatches.length === 0) {
		logger.error("commitToBranch: git apply --3way failed", logContext);
		throw new Error(`git apply --3way failed for task ${taskId}: ${logContext.threeWayStderr}`);
	}
	try {
		const withWip = await writeSyntheticTree(repoDir, parentSha, wipPatches);
		const deltaFiles = new Set(patchTouchedFiles(patchText));
		const wipOnly = new Set(wipPatches.flatMap(patchTouchedFiles).filter(f => !deltaFiles.has(f)));
		// WIP-only files are untouched by the delta, so their post-delta state
		// is the WIP state; diffing it back to the parent rewinds them.
		const rewind =
			wipOnly.size > 0
				? filterPatchFiles(await diffTreeOrEmpty(vcs.requireGit(repoDir), withWip, parentSha), wipOnly)
				: "";
		return await writeSyntheticTree(repoDir, parentSha, [...wipPatches, patchText, rewind]);
	} catch (wipErr) {
		if (!vcs.isVcsError(wipErr)) throw wipErr;
		const stderr = wipErr.stderr.slice(0, 2000);
		logger.error("commitToBranch: git apply with baseline WIP failed", { ...logContext, stderr });
		throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
	}
}

/** Commit `parentSha + patchText` as a detached commit object; returns its sha. */
async function commitPatch(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: VcsCommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	const tree = await patchTree(repoDir, parentSha, taskId, patchText, baselineWip);
	return vcs.requireGit(repoDir).commitTree(tree, [parentSha], message, author);
}

export interface CommitToBranchPatch {
	patch: string;
	author?: VcsCommitAuthor;
	/** Preserved message from an agent-authored commit. */
	message?: string;
	/** Diff whose message must be generated before local materialization. */
	messageDiff?: string;
	/** Baseline WIP needed to synthesize the patch safely. */
	baselineWip?: BaselineWipContext;
}

/**
 * Local branch-capture plan. It intentionally contains all diffs that may
 * need an AI message so callers can make those cloud requests after the
 * capture admission releases and before local commits begin.
 */
export interface CommitToBranchPreparation {
	isolationDir: string;
	repoRoot: string;
	taskId: string;
	branchName: string;
	baseSha: string;
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	fallbackMessage: string;
	/** Copy the child HEAD into the parent ODB before materializing patches. */
	fetchAgentHead: boolean;
	isolationHead?: string;
	patches: CommitToBranchPatch[];
	messageDiffs: string[];
}

interface FilteredAgentReplayPreparationOptions {
	baseline: WorktreeBaseline;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
}

/**
 * Resolve dirty-baseline replay into patch plans without committing them. The
 * temporary trees are local Git objects, while every cloud message wait is
 * deferred until the caller holds no allocation permit.
 */
async function prepareFilteredAgentReplay(
	opts: FilteredAgentReplayPreparationOptions,
): Promise<CommitToBranchPatch[]> {
	const baselineSha = opts.baseline.root.headCommit;
	const repo = vcs.requireGit(opts.repoRoot);
	const isolationRepo = vcs.requireGit(opts.isolationDir);
	const agentCommits = await isolationRepo.revListRange(baselineSha, opts.isolationHead);
	const baselineWip = [opts.baseline.root.staged, opts.baseline.root.unstaged, opts.baseline.root.untrackedPatch];
	await writeSyntheticTree(opts.repoRoot, baselineSha, baselineWip);
	const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, baselineWip);
	let previousFilteredTree = baselineSha;
	const patches: CommitToBranchPatch[] = [];

	for (const commitSha of agentCommits) {
		const taskStatePatch = await diffTreeOrEmpty(isolationRepo, dirtyBaselineTree, `${commitSha}^{tree}`);
		// The delta is captured against `HEAD + baseline WIP`, so synthesise the
		// filtered tree through `patchTree` with that WIP context: hunks that
		// touch WIP paths — including deletions of untracked WIP the agent never
		// committed — replay against the WIP state and are rewound afterwards
		// instead of failing against the clean baseline tree with
		// "patch does not apply: … does not exist".
		const currentFilteredTree = await patchTree(
			opts.repoRoot,
			baselineSha,
			opts.taskId,
			taskStatePatch,
			opts.baseline.root,
		);
		const commitPatchText = await diffTreeOrEmpty(repo, previousFilteredTree, currentFilteredTree);
		if (commitPatchText.trim()) {
			const details = await isolationRepo.commitDetails(commitSha);
			patches.push({
				patch: commitPatchText,
				message: details.message || commitSha,
				author: details.author,
			});
		}
		previousFilteredTree = currentFilteredTree;
	}
	if (patches.length === 0) {
		if (opts.rootPatch.trim()) {
			patches.push({
				patch: opts.rootPatch,
				messageDiff: opts.rootPatch,
				baselineWip: opts.baseline.root,
			});
		}
		return patches;
	}
	// Reconstruct the final HEAD-derived tree with the same dirty-side blobs
	// and 3-way synthesis used above; anything left is uncommitted work. The
	// same WIP context applies: `rootPatch` is captured against `HEAD + WIP`,
	// so synthesise through `patchTree` or hunks touching WIP paths fail on the
	// clean baseline tree ("patch does not apply: … does not exist").
	const finalFilteredTree = await patchTree(
		opts.repoRoot,
		baselineSha,
		opts.taskId,
		opts.rootPatch,
		opts.baseline.root,
	);
	const leftoverPatch = await diffTreeOrEmpty(repo, previousFilteredTree, finalFilteredTree);
	if (leftoverPatch.trim()) {
		patches.push({ patch: leftoverPatch, messageDiff: leftoverPatch });
	}
	return patches;
}

/**
 * Capture task-only changes and compute a local branch plan. It performs no
 * model request and creates no branch, so a caller may release host admission
 * before generating commit messages.
 */
export async function prepareCommitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
): Promise<CommitToBranchPreparation | null> {
	const baseSha = baseline.root.headCommit;
	const isolationRepo = vcs.requireGit(isolationDir);
	const isolationHead = (await isolationRepo.headSha()) ?? "";
	const agentCommitted = isolationHead !== "" && isolationHead !== baseSha;
	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;

	const repoRoot = baseline.root.repoRoot;
	const fallbackMessage = description || taskId;
	const preparation: CommitToBranchPreparation = {
		isolationDir,
		repoRoot,
		taskId,
		branchName: `omp/task/${taskId}`,
		baseSha,
		rootPatch,
		nestedPatches,
		fallbackMessage,
		fetchAgentHead: false,
		patches: [],
		messageDiffs: [],
	};
	if (!rootPatch.trim()) return preparation;

	if (agentCommitted && baselineHasRootWip(baseline.root)) {
		preparation.patches = await prepareFilteredAgentReplay({
			baseline,
			isolationDir,
			isolationHead,
			repoRoot,
			rootPatch,
		});
	} else if (agentCommitted) {
		preparation.fetchAgentHead = true;
		preparation.isolationHead = isolationHead;
		const leftoverPatch = await captureRepoDeltaPatch(isolationDir, {
			repoRoot: isolationDir,
			headCommit: isolationHead,
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		});
		if (leftoverPatch.trim()) {
			preparation.patches.push({ patch: leftoverPatch, messageDiff: leftoverPatch });
		}
	} else {
		preparation.patches.push({
			patch: rootPatch,
			messageDiff: rootPatch,
			baselineWip: baselineHasRootWip(baseline.root) ? baseline.root : undefined,
		});
	}
	preparation.messageDiffs = preparation.patches.flatMap(patch => (patch.messageDiff ? [patch.messageDiff] : []));
	return preparation;
}

/**
 * Materialize a previously captured branch plan. The supplied messages are
 * already settled values, never callbacks, so this local Git work cannot
 * retain admission while an AI provider is waiting.
 */
export async function finalizeCommitToBranch(
	preparation: CommitToBranchPreparation,
	messages: readonly (string | null | undefined)[] = [],
): Promise<CommitToBranchResult | null> {
	if (!preparation.rootPatch.trim()) {
		return { rootPatch: preparation.rootPatch, nestedPatches: preparation.nestedPatches };
	}
	const repo = vcs.requireGit(preparation.repoRoot);
	let tip = preparation.baseSha;
	if (preparation.fetchAgentHead) {
		const isolationHead = preparation.isolationHead;
		if (!isolationHead) throw new Error("Missing isolated agent HEAD for branch materialization.");
		await repo.fetch(preparation.isolationDir, "HEAD", `refs/heads/${preparation.branchName}`, GIT_NETWORK_TIMEOUT_MS);
		tip = isolationHead;
	}
	let messageIndex = 0;
	for (const patch of preparation.patches) {
		const generatedMessage = patch.messageDiff ? messages[messageIndex++] : undefined;
		const message = patch.message ?? generatedMessage ?? preparation.fallbackMessage;
		tip = await commitPatch(
			preparation.repoRoot,
			tip,
			preparation.taskId,
			patch.patch,
			message,
			patch.author,
			patch.baselineWip,
		);
	}
	if (tip === preparation.baseSha) {
		return {
			rootPatch: preparation.rootPatch,
			baseSha: preparation.baseSha,
			nestedPatches: preparation.nestedPatches,
		};
	}
	await repo.createBranch(preparation.branchName, tip, true);
	return {
		branchName: preparation.branchName,
		baseSha: preparation.baseSha,
		rootPatch: preparation.rootPatch,
		nestedPatches: preparation.nestedPatches,
	};
}

/**
 * Compatibility wrapper for direct callers. Isolation lifecycle code uses the
 * prepare/message/finalize phases independently to keep cloud waits outside
 * the allocation operation.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const preparation = await prepareCommitToBranch(isolationDir, baseline, taskId, description);
	if (!preparation) return null;
	const messages: Array<string | null | undefined> = [];
	if (commitMessage) {
		for (const diff of preparation.messageDiffs) {
			messages.push(await commitMessage(diff));
		}
	}
	return finalizeCommitToBranch(preparation, messages);
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD. When `baseSha` is
 * provided the cherry-pick uses the inclusive range `baseSha..branchName`,
 * replaying every commit individually and preserving each commit's message
 * and author. When omitted, the branch is cherry-picked as a single commit
 * (legacy callers).
 *
 * The working tree is never stashed: each pick rewrites only the paths it
 * changes and is refused when one of them carries uncommitted edits, so
 * unrelated dirty files (and LFS checkouts) are left untouched.
 *
 * Stops on the first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges would race on HEAD and the index.
	return withRepoLock(repoRoot, async () => {
		const repo = vcs.requireGit(repoRoot);
		const merged: string[] = [];
		for (const { branchName, baseSha } of branches) {
			try {
				const revisions = baseSha ? await repo.revListRange(baseSha, branchName) : [branchName];
				for (const revision of revisions) {
					try {
						await repo.cherryPick(revision);
					} catch (error) {
						if (!vcs.isEmptyCherryPick(error)) throw error;
					}
				}
			} catch (error) {
				const stderr = vcs.isVcsError(error)
					? error.stderr.trim()
					: error instanceof Error
						? error.message
						: String(error);
				return {
					merged,
					failed: branches.slice(merged.length).map(b => b.branchName),
					conflict: `${branchName}: ${stderr}`,
				};
			}
			merged.push(branchName);
		}
		return { merged, failed: [] };
	});
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	const repo = vcs.requireGit(repoRoot);
	for (const branch of branches) {
		try {
			await repo.deleteBranch(branch, true);
		} catch {
			// Best-effort cleanup matches the old façade's tryDelete semantics.
		}
	}
}
