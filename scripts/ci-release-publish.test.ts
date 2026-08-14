import { describe, expect, it } from "bun:test";
import { packages, rewriteManifest } from "./ci-release-publish";

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
		});
	});

	it("publishes @ompd/core before its coding-agent consumer", async () => {
		const coreIndex = packages.findIndex(entry => entry.dir === "control-plane/packages/core");
		const codingAgentIndex = packages.findIndex(entry => entry.dir === "packages/coding-agent");
		expect(coreIndex).toBeGreaterThan(-1);
		expect(coreIndex).toBeLessThan(codingAgentIndex);

		const core = packages[coreIndex];
		const codingAgent = packages[codingAgentIndex];
		if (!core || !codingAgent) throw new Error("@ompd/core or coding-agent missing from publish set");

		const [coreManifest, codingAgentManifest] = await Promise.all([
			rewriteManifest(core, false),
			rewriteManifest(codingAgent, false),
		]);
		expect(coreManifest.version).toBe(codingAgentManifest.version);
		expect(coreManifest.files).toContain("dist/types");
		expect(coreManifest.exports).toMatchObject({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./contracts": {
				types: "./dist/types/contracts.d.ts",
				import: "./src/contracts.ts",
			},
			"./ompd-client": {
				types: "./dist/types/ompd-client.d.ts",
				import: "./src/ompd-client.ts",
			},
			"./store": {
				types: "./dist/types/store.d.ts",
				import: "./src/store.ts",
			},
			"./redact": {
				types: "./dist/types/redact.d.ts",
				import: "./src/redact.ts",
			},
		});
	});
});
