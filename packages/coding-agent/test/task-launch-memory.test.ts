import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	ensurePersistedRoster,
	type PersistedRosterDiagnostic,
} from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-10-22T00:00:00.000Z";

function sessionHeader(id: string) {
	return { type: "session", version: 3, id, timestamp: TIMESTAMP, cwd: "/synthetic" };
}

async function writeChild(file: string, id: string): Promise<void> {
	await Bun.write(
		file,
		[
			JSON.stringify(sessionHeader(id)),
			JSON.stringify({
				type: "session_init",
				timestamp: TIMESTAMP,
				task: "Synthetic roster fixture",
				systemPrompt: ["Synthetic child."],
				agent: "task",
				modelRole: "task",
			}),
			JSON.stringify({
				type: "message",
				id: `${id}-historic`,
				parentId: null,
				timestamp: TIMESTAMP,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Historic output must stay on disk during roster restoration." }],
					usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 1 } },
				},
			}),
		].join("\n") + "\n",
	);
}

describe("task launch memory boundaries", () => {
	it("coalesces same-root roster restoration without hydrating historical child conversations", async () => {
		using tempDir = TempDir.createSync("@task-launch-memory-");
		const rootFile = tempDir.join("root.jsonl");
		const artifactsDir = rootFile.slice(0, -".jsonl".length);
		await Bun.write(rootFile, `${JSON.stringify(sessionHeader("root"))}\n`);
		for (const id of ["alpha", "beta", "gamma"]) {
			await writeChild(path.join(artifactsDir, `${id}.jsonl`), id);
		}

		const registry = new AgentRegistry();
		const diagnostics: PersistedRosterDiagnostic[] = [];
		const roots = await Promise.all(
			Array.from({ length: 16 }, () =>
				ensurePersistedRoster(registry, rootFile, { onDiagnostic: event => diagnostics.push(event) }),
			),
		);

		expect(roots).toEqual(Array(16).fill(rootFile));
		expect(diagnostics.filter(event => event.phase === "root_stream")).toHaveLength(1);
		expect(diagnostics.filter(event => event.phase === "metadata_prefix")).toHaveLength(3);
		expect(diagnostics.filter(event => event.phase === "history_hydration")).toHaveLength(0);
		const refs = registry.list().filter(ref => ref.kind === "sub");
		expect(refs).toHaveLength(3);
		expect(refs.every(ref => ref.history?.directCost === undefined)).toBe(true);

		await ensurePersistedRoster(registry, rootFile, { onDiagnostic: event => diagnostics.push(event) });
		expect(diagnostics.filter(event => event.phase === "root_stream")).toHaveLength(1);
		expect(diagnostics.filter(event => event.phase === "latch_reused")).toHaveLength(1);
	});

	it("opens a new task session with parent metadata but no inherited conversation", async () => {
		using tempDir = TempDir.createSync("@task-launch-empty-history-");
		const parentFile = tempDir.join("parent.jsonl");
		const childFile = tempDir.join("child.jsonl");
		await Bun.write(
			parentFile,
			[
				JSON.stringify(sessionHeader("parent")),
				JSON.stringify({
					type: "message",
					id: "parent-message",
					parentId: null,
					timestamp: TIMESTAMP,
					message: { role: "user", content: [{ type: "text", text: "Parent-only text." }] },
				}),
			].join("\n") + "\n",
		);

		const child = await SessionManager.open(childFile, tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			parentSession: parentFile,
			suppressBreadcrumb: true,
		});
		try {
			expect(child.getHeader()?.parentSession).toBe(parentFile);
			expect(child.getEntries().filter(entry => entry.type === "message")).toEqual([]);
		} finally {
			await child.close();
		}
	});
});
