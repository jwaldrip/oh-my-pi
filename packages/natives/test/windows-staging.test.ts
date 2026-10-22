/**
 * Regression for the Windows `bun install -g` update path: when an `omp`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * The fix has two halves, both pinned by this test:
 *   1. The loader stages `nativeDir/<filename>.node` → `versionedDir/<filename>.node`
 *      (per-package-version cache under `~/.omp/natives/<version>/`) so the
 *      running process holds its OS-level handle on a path bun is never asked
 *      to overwrite. Gated to Windows + node_modules installs + non-compiled
 *      mode by `shouldStageNodeModulesAddon`.
 *   2. `resolveLoaderCandidates` puts the staged path ahead of the
 *      `node_modules` path so subsequent updates land in node_modules without
 *      contention.
 *
 * Both behaviors are off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAddonFilenames,
	initLoaderContext,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\oh-my-pi\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@oh-my-pi/pi-natives/native";

describe("windows native addon staging", () => {
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("prepends versionedDir candidates ahead of node_modules when staging on Windows", () => {
		const versionedDir = "C:\\Users\\Admin\\.omp\\natives\\15.0.1";
		const userDataDir = "C:\\Users\\Admin\\AppData\\Local\\omp";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir,
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.win32-x64-baseline.node");
		const versionedDefault = path.join(versionedDir, "pi_natives.win32-x64.node");
		const nodeModulesBaseline = path.join(winNodeModulesNativeDir, "pi_natives.win32-x64-baseline.node");

		// Staged paths must be probed first so the running process locks the cache
		// copy and bun is free to replace the node_modules copy on next update.
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(versionedDefault);
		expect(candidates.indexOf(versionedBaseline)).toBeLessThan(candidates.indexOf(nodeModulesBaseline));

		// User-data dir is reserved for compiled-binary mode — staging must not
		// quietly start probing it on npm installs (where it never contains the
		// addon anyway).
		const userDataBaseline = path.join(userDataDir, "pi_natives.win32-x64-baseline.node");
		expect(candidates).not.toContain(userDataBaseline);
	});

	it("classifies only Windows node_modules paths case-insensitively", () => {
		const leafPackageDir = "/tmp/node_modules/@oh-my-pi/pi-natives-darwin-arm64";
		const uppercaseNodeModulesNativeDir = "/tmp/NODE_MODULES/@oh-my-pi/pi-natives/native";
		const variantCacheKey = "__PI_NATIVE_VARIANT_CACHE";
		const previousVariantCache = process.env[variantCacheKey];
		try {
			const workspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/oh-my-pi/packages/natives/native",
				leafPackageDir,
			});
			const installed = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/node_modules/@oh-my-pi/pi-natives/native",
				leafPackageDir,
			});
			const uppercaseWorkspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const uppercaseWindowsInstall = initLoaderContext({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const leafCandidate = path.join(leafPackageDir, installed.addonFilenames[0]);
			const windowsLeafCandidate = path.join(leafPackageDir, uppercaseWindowsInstall.addonFilenames[0]);
			const workspaceCandidate = path.join(uppercaseNodeModulesNativeDir, uppercaseWorkspace.addonFilenames[0]);

			expect(workspace.isWorkspaceLoad).toBe(true);
			expect(workspace.leafPackageDir).toBeNull();
			expect(workspace.candidates).not.toContain(leafCandidate);
			expect(installed.isWorkspaceLoad).toBe(false);
			expect(installed.leafPackageDir).toBe(leafPackageDir);
			expect(installed.candidates).toContain(leafCandidate);
			expect(installed.candidates[0]).toBe(leafCandidate);

			expect(uppercaseWorkspace.isWorkspaceLoad).toBe(true);
			expect(uppercaseWorkspace.leafPackageDir).toBeNull();
			expect(uppercaseWorkspace.candidates[0]).toBe(workspaceCandidate);

			expect(uppercaseWindowsInstall.isWorkspaceLoad).toBe(false);
			expect(uppercaseWindowsInstall.leafPackageDir).toBe(leafPackageDir);
			expect(uppercaseWindowsInstall.stageFromNodeModules).toBe(true);
			expect(uppercaseWindowsInstall.candidates).toContain(windowsLeafCandidate);
		} finally {
			if (previousVariantCache === undefined) delete process.env[variantCacheKey];
			else process.env[variantCacheKey] = previousVariantCache;
		}
	});

	it("retains old cache files while reusing a populated private current cache", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-cache-"));
		const nativeDir = path.join(import.meta.dir, "../native");
		const platformTag = `${process.platform}-${process.arch}`;
		const addonFilenames = getAddonFilenames({
			tag: platformTag,
			arch: process.arch,
			variant: process.arch === "x64" ? "baseline" : null,
		});
		const availableNativeFiles = new Set(await fs.readdir(nativeDir));
		const currentAddonFilenames = addonFilenames.filter(filename => availableNativeFiles.has(filename));
		const versionedDir = path.join(nativesDir, packageJson.version);
		const oldFiles = [
			path.join(nativesDir, "15.10.11", "held.node"),
			path.join(nativesDir, "18.12.5", "retained.node"),
		];
		const oldVersionDirs = oldFiles.map(filePath => path.dirname(filePath));

		try {
			expect(currentAddonFilenames.length).toBeGreaterThan(0);
			await fs.mkdir(versionedDir, { recursive: true });
			await Promise.all(
				currentAddonFilenames.map(filename =>
					fs.copyFile(path.join(nativeDir, filename), path.join(versionedDir, filename)),
				),
			);
			await Promise.all(
				oldFiles.map(async (filePath, index) => {
					await fs.mkdir(path.dirname(filePath), { recursive: true });
					await fs.writeFile(filePath, `older cache ${index}`);
				}),
			);
			await Promise.all(oldVersionDirs.map(dir => fs.utimes(dir, new Date(0), new Date(0))));

			const oldFilesBefore = await Promise.all(
				oldFiles.map(async filePath => ({
					filePath,
					bytes: await fs.readFile(filePath),
					stat: await fs.stat(filePath),
				})),
			);
			const currentAddonsBefore = new Map(
				await Promise.all(
					currentAddonFilenames.map(async filename => {
						const filePath = path.join(versionedDir, filename);
						return [filePath, await fs.stat(filePath)] as const;
					}),
				),
			);
			const heldOldFile = await fs.open(oldFiles[0], "r");

			try {
				// This covers only already-populated caches under the patched process's
				// private root. First-writer races and old processes using the default
				// root are separate compatibility paths.
				const loaderStatePath = path.join(import.meta.dir, "../native/loader-state.js");
				// The child must load after its isolated environment is installed, so
				// this test intentionally imports the loader dynamically.
				const loadCurrentAddon = async () => {
					const child = Bun.spawn(
						[
							process.execPath,
							"--eval",
							`(async () => {
								const { loadNative, nativeAddonStatus } = await import(${JSON.stringify(loaderStatePath)});
								loadNative();
								const status = nativeAddonStatus();
								if (!status) throw new Error("native addon did not report a successful load");
								process.stdout.write(status.path);
							})().catch(error => {
								console.error(error instanceof Error ? error.stack ?? error.message : String(error));
								process.exitCode = 1;
							});`,
						],
						{
							env: {
								...process.env,
								PI_COMPILED: "1",
								PI_NATIVES_DIR: nativesDir,
								PI_NATIVE_VARIANT: process.arch === "x64" ? "baseline" : "",
								__PI_NATIVE_VARIANT_CACHE: "",
							},
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					const [exitCode, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect(exitCode, stderr).toBe(0);
					return stdout.trim();
				};

				const firstLoad = await loadCurrentAddon();
				const concurrentLoads = await Promise.all([loadCurrentAddon(), loadCurrentAddon()]);
				const repeatedLoad = await loadCurrentAddon();
				for (const loadedPath of [firstLoad, ...concurrentLoads, repeatedLoad]) {
					expect(currentAddonsBefore.has(loadedPath)).toBe(true);
				}

				for (const [filePath, before] of currentAddonsBefore) {
					const after = await fs.stat(filePath);
					expect(after.ino).toBe(before.ino);
					expect(after.nlink).toBe(before.nlink);
				}
				for (const { filePath, bytes, stat } of oldFilesBefore) {
					expect(await fs.readFile(filePath)).toEqual(bytes);
					const after = await fs.stat(filePath);
					expect(after.ino).toBe(stat.ino);
					expect(after.nlink).toBe(stat.nlink);
				}
				expect((await fs.readdir(nativesDir)).sort()).toEqual(
					["15.10.11", "18.12.5", packageJson.version].sort(),
				);
			} finally {
				await heldOldFile.close();
			}
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});
