import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasLiveDaemonProjectPresence, registerDaemonProjectPresence } from "../../src/launch/presence";

/**
 * The `sessionId`/`title` fields added to the presence record must be purely
 * additive: an older `omp` on the same machine never writes them, and a
 * reader that only understands `{pid, id, projectDir}` (the pre-existing
 * shape `hasLiveDaemonProjectPresence` itself parses) must keep working
 * against both an old-format record and a new one that carries them.
 */
describe("daemon presence session identity field", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		while (dirs.length) {
			await fs.rm(dirs.pop() ?? "", { recursive: true, force: true });
		}
	});

	async function tmpProject(): Promise<{ projectDir: string; runtimeDir: string }> {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-presence-session-"));
		dirs.push(projectDir);
		return { projectDir, runtimeDir: path.join(projectDir, "runtime") };
	}

	it("writes sessionId and title when a session is supplied", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir, {
			sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
			title: "Refactor the launcher",
		});
		try {
			const clientsDir = path.join(runtimeDir, "clients");
			const [entry] = await fs.readdir(clientsDir);
			const record = (await Bun.file(path.join(clientsDir, entry!)).json()) as Record<string, unknown>;
			expect(record.sessionId).toBe("019fee60-2c7a-7000-9fd5-7439c7bf3dd2");
			expect(record.title).toBe("Refactor the launcher");
			expect(record.pid).toBe(process.pid);
		} finally {
			await presence.close();
		}
	});

	it("omits sessionId and title entirely when no session is supplied, matching the pre-field record shape", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			const clientsDir = path.join(runtimeDir, "clients");
			const [entry] = await fs.readdir(clientsDir);
			const record = (await Bun.file(path.join(clientsDir, entry!)).json()) as Record<string, unknown>;
			expect("sessionId" in record).toBe(false);
			expect("title" in record).toBe(false);
			expect(Object.keys(record).sort()).toEqual(["id", "pid", "projectDir"]);
		} finally {
			await presence.close();
		}
	});

	it("hasLiveDaemonProjectPresence reports liveness from a legacy record with no sessionId/title field at all", async () => {
		const { runtimeDir } = await tmpProject();
		const clientsDir = path.join(runtimeDir, "clients");
		await fs.mkdir(clientsDir, { recursive: true });
		// Simulated write from an omp build that predates this field: exactly the
		// old three-key shape, nothing more.
		await Bun.write(
			path.join(clientsDir, `${process.pid}-legacy.json`),
			JSON.stringify({ pid: process.pid, id: `${process.pid}-legacy`, projectDir: runtimeDir }),
		);

		// Degrades to "alive, session unknown": liveness still reads correctly
		// from the pid alone, and no exception is thrown reading a record that
		// lacks the newer fields.
		await expect(hasLiveDaemonProjectPresence(runtimeDir)).resolves.toBe(true);
	});
});
