#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
const identityFiles = [
	"packages/coding-agent/src/modes/interactive-mode.ts",
	"packages/coding-agent/src/registry/persisted-agents.ts",
	"packages/coding-agent/src/session/session-loader.ts",
	"packages/coding-agent/test/session-retention-memory-probe.ts",
] as const;

function valueFor(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function requiredValue(flag: string): string {
	const value = valueFor(flag);
	if (value === undefined) throw new Error(`${flag} is required`);
	return value;
}

async function checksum(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

function machoUuid(file: string): string {
	const result = Bun.spawnSync(["dwarfdump", "--uuid", file], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`dwarfdump failed for ${file}`);
	const output = new TextDecoder().decode(result.stdout);
	const match = /UUID: ([0-9A-F-]+)/.exec(output);
	if (!match) throw new Error(`dwarfdump did not return a UUID for ${file}`);
	return match[1]!;
}

async function main(): Promise<void> {
	const outfile = path.resolve(requiredValue("--outfile"));
	const runtime = path.resolve(requiredValue("--runtime"));
	const nativeDir = path.resolve(requiredValue("--native-dir"));
	const entrypoint = path.resolve(
		valueFor("--entrypoint") ?? path.join(packageDir, "test", "session-retention-memory-probe.ts"),
	);
	const label = valueFor("--label") ?? "probe";
	if (!(await Bun.file(runtime).exists())) throw new Error(`Bun runtime template is missing: ${runtime}`);
	if (!(await Bun.file(entrypoint).exists())) throw new Error(`probe entrypoint is missing: ${entrypoint}`);
	const nativeAddon = path.join(nativeDir, `pi_natives.${process.platform}-${process.arch}.node`);
	if (!(await Bun.file(nativeAddon).exists())) throw new Error(`native addon is missing: ${nativeAddon}`);
	const embeddedNativeAddon = path.join(
		repoRoot,
		"packages",
		"natives",
		"native",
		`pi_natives.${process.platform}-${process.arch}.node`,
	);
	if (
		!(await Bun.file(embeddedNativeAddon).exists()) ||
		(await checksum(embeddedNativeAddon)) !== (await checksum(nativeAddon))
	) {
		await fs.copyFile(nativeAddon, embeddedNativeAddon);
	}
	await fs.mkdir(path.dirname(outfile), { recursive: true });

	const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
	if (
		typeof transformersManifest !== "object" ||
		transformersManifest === null ||
		!("version" in transformersManifest) ||
		typeof transformersManifest.version !== "string"
	) {
		throw new Error("@huggingface/transformers package manifest has no string version");
	}
	await compileCodingAgent({
		repoRoot,
		entrypoint,
		outfile,
		transformersVersion: transformersManifest.version,
		native: { platform: process.platform, arch: process.arch },
		executablePath: runtime,
		minifyIdentifiers: false,
	});

	const bunWithRevision = Bun as typeof Bun & { revision?: string };
	const sourceChecksums = Object.fromEntries(
		await Promise.all(identityFiles.map(async file => [file, await checksum(path.join(repoRoot, file))] as const)),
	);
	const nativeAddonBytes = (await fs.stat(nativeAddon)).size;
	const receipt = {
		schemaVersion: 1,
		label,
		bunVersion: Bun.version,
		bunRevision: bunWithRevision.revision ?? null,
		runtimeChecksum: await checksum(runtime),
		nativeAddonChecksum: await checksum(nativeAddon),
		nativeAddonBytes,
		nativeAddonUuid: machoUuid(nativeAddon),
		compiledChecksum: await checksum(outfile),
		buildOptions: {
			entrypoint: path.relative(repoRoot, entrypoint),
			platform: process.platform,
			arch: process.arch,
			minifyIdentifiers: false,
		},
		sourceChecksums,
	};
	const receiptPath = `${outfile}.memory-probe.json`;
	await Bun.write(receiptPath, `${JSON.stringify(receipt)}\n`);
	process.stdout.write(`${JSON.stringify({ outfile, receiptPath, ...receipt })}\n`);
}

void main().catch(error => {
	process.stderr.write(`compile memory probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
