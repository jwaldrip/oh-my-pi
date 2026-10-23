import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	ensurePersistedRoster,
	type PersistedRosterDiagnostic,
} from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";

const MIB = 1024 * 1024;
const MAX_SYNTHETIC_PARENT_BYTES = 32 * MIB;
const SYNTHETIC_TIMESTAMP = "2026-10-22T00:00:00.000Z";

interface ProbeRow {
	timestamp: number;
	pid: number;
	phase: string;
	invocationId: string;
	nativeTag: string | null;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
	bytesConsumed: number;
	recordsVisited: number;
	resultCount: number;
}

interface ProbeOptions {
	mode: "dummy-allocate" | "loader" | "roster" | "fresh-session" | "child-setup" | "task-startup" | "render" | "all";
	fixtureBytes: number;
	parentBytes: number;
	children: number;
	calls: number;
	cycles: number;
	shape: "normal" | "large";
	chunkBytes: number;
}

function valueFor(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function positiveInteger(flag: string, fallback: number): number {
	const text = valueFor(flag);
	if (text === undefined) return fallback;
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
	return value;
}

function parseOptions(): ProbeOptions {
	const mode = valueFor("--mode") ?? "all";
	if (
		!(
			[
				"dummy-allocate",
				"loader",
				"roster",
				"fresh-session",
				"child-setup",
				"task-startup",
				"render",
				"all",
			] as const
		).includes(mode as ProbeOptions["mode"])
	) {
		throw new Error(`unsupported mode: ${mode}`);
	}
	const fixtureBytes = positiveInteger("--fixture-bytes", 4 * MIB);
	const parentBytes = positiveInteger("--parent-bytes", 4 * MIB);
	const children = positiveInteger("--children", 480);
	const calls = positiveInteger("--calls", 16);
	const cycles = positiveInteger("--cycles", 1);
	const chunkBytes = positiveInteger("--chunk-bytes", 32 * MIB);
	const shape = valueFor("--shape") ?? "normal";
	if (shape !== "normal" && shape !== "large") throw new Error(`unsupported shape: ${shape}`);
	if (fixtureBytes > MAX_SYNTHETIC_PARENT_BYTES || parentBytes > MAX_SYNTHETIC_PARENT_BYTES) {
		throw new Error(`synthetic input exceeds ${MAX_SYNTHETIC_PARENT_BYTES} bytes`);
	}
	return {
		mode: mode as ProbeOptions["mode"],
		fixtureBytes,
		parentBytes,
		children,
		calls,
		cycles,
		shape,
		chunkBytes,
	};
}

function emit(
	phase: string,
	invocationId: string,
	metrics: Pick<ProbeRow, "bytesConsumed" | "recordsVisited" | "resultCount">,
	nativeTag: string | null = null,
): void {
	const memory = process.memoryUsage();
	const row: ProbeRow = {
		timestamp: Date.now(),
		pid: process.pid,
		phase,
		invocationId,
		nativeTag,
		heapUsed: memory.heapUsed,
		heapTotal: memory.heapTotal,
		external: memory.external,
		arrayBuffers: memory.arrayBuffers,
		...metrics,
	};
	process.stdout.write(`${JSON.stringify(row)}\n`);
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
	Bun.gc(true);
	Bun.gc(true);
	await Bun.sleep(50);
}

function sessionHeader(id: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: SYNTHETIC_TIMESTAMP, cwd: "/synthetic" };
}

function messageRecord(id: string, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: SYNTHETIC_TIMESTAMP,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

async function writeJsonLine(handle: fs.FileHandle, value: unknown): Promise<number> {
	const line = `${JSON.stringify(value)}\n`;
	await handle.write(line);
	return Buffer.byteLength(line, "utf8");
}

async function writeLoaderFixture(
	file: string,
	targetBytes: number,
	shape: ProbeOptions["shape"],
	id: string,
): Promise<void> {
	const handle = await fs.open(file, "w");
	let written = 0;
	try {
		written += await writeJsonLine(handle, sessionHeader(id));
		let index = 0;
		while (written < targetBytes) {
			const remaining = targetBytes - written;
			const desiredRecordBytes = shape === "large" && index === 0 ? remaining : Math.min(64 * 1024, remaining);
			const overhead = Buffer.byteLength(JSON.stringify(messageRecord(`${id}-${index}`, "")), "utf8") + 1;
			const textBytes = Math.max(1, desiredRecordBytes - overhead);
			written += await writeJsonLine(handle, messageRecord(`${id}-${index}`, "x".repeat(textBytes)));
			index++;
		}
	} finally {
		await handle.close();
	}
}

async function runLoader(file: string, invocationId: string, cycles: number): Promise<void> {
	for (let cycle = 0; cycle < cycles; cycle++) {
		let bytesConsumed = 0;
		let recordsVisited = 0;
		emit("loader:begin", `${invocationId}:${cycle}`, { bytesConsumed, recordsVisited, resultCount: 0 });
		await visitEntriesFromFileStream(
			file,
			() => {
				recordsVisited++;
			},
			{
				onBytesConsumed: bytes => {
					bytesConsumed += bytes;
				},
			},
		);
		emit("loader:complete", `${invocationId}:${cycle}`, {
			bytesConsumed,
			recordsVisited,
			resultCount: recordsVisited,
		});
		await settle();
		emit("loader:disposed", `${invocationId}:${cycle}`, {
			bytesConsumed,
			recordsVisited,
			resultCount: recordsVisited,
		});
	}
}

async function writeChildTranscript(file: string, id: string): Promise<void> {
	const handle = await fs.open(file, "w");
	try {
		await writeJsonLine(handle, sessionHeader(id));
		await writeJsonLine(handle, {
			type: "session_init",
			timestamp: SYNTHETIC_TIMESTAMP,
			task: "Synthetic metadata probe",
			systemPrompt: ["Synthetic child session."],
			agent: "task",
			modelRole: "task",
		});
		await writeJsonLine(handle, {
			type: "message",
			id: `${id}-historic`,
			parentId: null,
			timestamp: SYNTHETIC_TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Synthetic historical child output." }],
				usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 1 } },
			},
		});
	} finally {
		await handle.close();
	}
}

function diagnosticMetrics(
	diagnostic: PersistedRosterDiagnostic,
): Pick<ProbeRow, "bytesConsumed" | "recordsVisited" | "resultCount"> {
	return {
		bytesConsumed: diagnostic.bytesConsumed,
		recordsVisited: diagnostic.recordsVisited,
		resultCount: diagnostic.resultCount,
	};
}

async function runRoster(rootFile: string, options: ProbeOptions): Promise<void> {
	const rootDir = rootFile.slice(0, -".jsonl".length);
	await fs.mkdir(rootDir, { recursive: true });
	await writeLoaderFixture(rootFile, options.parentBytes, "large", "root");
	await Promise.all(
		Array.from({ length: options.children }, async (_, index) => {
			await writeChildTranscript(
				path.join(rootDir, `child-${String(index).padStart(3, "0")}.jsonl`),
				`child-${index}`,
			);
		}),
	);

	const registry = new AgentRegistry();
	const diagnostics: PersistedRosterDiagnostic[] = [];
	const onDiagnostic = (diagnostic: PersistedRosterDiagnostic): void => {
		diagnostics.push(diagnostic);
		emit(`roster:${diagnostic.phase}`, "roster", diagnosticMetrics(diagnostic));
	};
	emit("roster:begin", "roster", { bytesConsumed: 0, recordsVisited: 0, resultCount: 0 });
	const roots = await Promise.all(
		Array.from({ length: options.calls }, () => ensurePersistedRoster(registry, rootFile, { onDiagnostic })),
	);
	if (roots.some(root => root !== rootFile)) throw new Error("same-root roster calls resolved different roots");
	const rootStreams = diagnostics.filter(diagnostic => diagnostic.phase === "root_stream");
	const metadataReads = diagnostics.filter(diagnostic => diagnostic.phase === "metadata_prefix");
	const historyHydrations = diagnostics.filter(diagnostic => diagnostic.phase === "history_hydration");
	const refs = registry.list().filter(ref => ref.kind === "sub");
	if (rootStreams.length !== 1) throw new Error(`expected one root stream, observed ${rootStreams.length}`);
	if (metadataReads.length !== options.children) {
		throw new Error(`expected ${options.children} metadata reads, observed ${metadataReads.length}`);
	}
	if (historyHydrations.length !== 0) throw new Error("roster hydration was enabled during task launch");
	if (refs.length !== options.children)
		throw new Error(`expected ${options.children} parked children, observed ${refs.length}`);
	if (refs.some(ref => ref.history?.directCost !== undefined))
		throw new Error("historical child usage was hydrated during task launch");
	await ensurePersistedRoster(registry, rootFile, { onDiagnostic });
	if (diagnostics.filter(diagnostic => diagnostic.phase === "root_stream").length !== 1) {
		throw new Error("settled same-root latch re-scanned the root transcript");
	}
	if (!diagnostics.some(diagnostic => diagnostic.phase === "latch_reused")) {
		throw new Error("settled same-root latch was not reused");
	}
	emit("roster:complete", "roster", {
		bytesConsumed: rootStreams[0]?.bytesConsumed ?? 0,
		recordsVisited: rootStreams[0]?.recordsVisited ?? 0,
		resultCount: refs.length,
	});
	await settle();
	emit("roster:disposed", "roster", {
		bytesConsumed: rootStreams[0]?.bytesConsumed ?? 0,
		recordsVisited: rootStreams[0]?.recordsVisited ?? 0,
		resultCount: refs.length,
	});
}

async function runFreshSession(dir: string, rootFile: string): Promise<void> {
	await writeLoaderFixture(rootFile, 4 * MIB, "normal", "parent");
	const childFile = path.join(dir, "fresh-child.jsonl");
	emit("fresh-session:begin", "fresh-session", { bytesConsumed: 0, recordsVisited: 0, resultCount: 0 });
	const manager = await SessionManager.open(childFile, dir, undefined, {
		initialCwd: dir,
		parentSession: rootFile,
		suppressBreadcrumb: true,
	});
	const messageCount = manager.getEntries().filter(entry => entry.type === "message").length;
	const parentSession = manager.getHeader()?.parentSession;
	if (messageCount !== 0 || parentSession !== rootFile) {
		throw new Error("fresh child session inherited parent conversation entries");
	}
	await manager.close();
	emit("fresh-session:complete", "fresh-session", { bytesConsumed: 0, recordsVisited: messageCount, resultCount: 0 });
	await settle();
	emit("fresh-session:disposed", "fresh-session", { bytesConsumed: 0, recordsVisited: messageCount, resultCount: 0 });
}

async function runChildSetup(dir: string, rootFile: string, cycles: number): Promise<void> {
	registerMockApi();
	for (let index = 0; index < cycles; index++) {
		const invocationId = `child-setup:${index}`;
		const childFile = path.join(dir, `child-setup-${index}.jsonl`);
		const authStorage = await AuthStorage.create(":memory:");
		const mock = createMockModel({ responses: [{ content: ["synthetic completion"] }] });
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"async.enabled": false,
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
			"mnemopi.llmMode": "none",
		});
		const sessionManager = await SessionManager.open(childFile, dir, undefined, {
			initialCwd: dir,
			parentSession: rootFile,
			suppressBreadcrumb: true,
		});
		emit("child-setup:begin", invocationId, { bytesConsumed: 0, recordsVisited: 0, resultCount: 0 });
		try {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				agentId: `Synthetic${index}`,
				agentName: "task",
				parentAgentId: "Main",
				authStorage,
				getApiKey: () => "synthetic-key",
				modelRegistry: new ModelRegistry(authStorage),
				model: mock,
				settings,
				sessionManager,
				agentRegistry: new AgentRegistry(),
				bindProcessState: false,
				disableExtensionDiscovery: true,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				restrictToolNames: true,
				toolNames: ["read"],
				skills: [],
				rules: [],
				contextFiles: [{ path: "/synthetic/AGENTS.md", content: "Synthetic context." }],
				promptTemplates: [],
				slashCommands: [],
				workspaceTree: {
					rootPath: dir,
					rendered: "synthetic workspace",
					truncated: false,
					totalLines: 1,
					agentsMdFiles: [],
				},
			});
			const inheritedMessages = sessionManager.getEntries().filter(entry => entry.type === "message").length;
			if (inheritedMessages !== 0) throw new Error("mock child setup inherited parent conversation entries");
			await session.dispose();
			emit("child-setup:complete", invocationId, {
				bytesConsumed: 0,
				recordsVisited: inheritedMessages,
				resultCount: 1,
			});
		} finally {
			authStorage.close();
		}
		await settle();
		emit("child-setup:disposed", invocationId, { bytesConsumed: 0, recordsVisited: 0, resultCount: 1 });
	}
}

async function runTaskStartupControl(rootFile: string, childCount: number, options: ProbeOptions): Promise<void> {
	const rootDir = rootFile.slice(0, -".jsonl".length);
	await fs.mkdir(rootDir, { recursive: true });
	await writeLoaderFixture(rootFile, options.parentBytes, "large", path.basename(rootDir));
	await Promise.all(
		Array.from({ length: childCount }, async (_, index) => {
			const id = `${path.basename(rootDir)}-child-${String(index).padStart(3, "0")}`;
			await writeChildTranscript(path.join(rootDir, `${id}.jsonl`), id);
		}),
	);

	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		responses: Array.from({ length: options.cycles }, () => ({ content: ["synthetic completion"] })),
	});
	authStorage.keys.setRuntime("mock", "synthetic-key");
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	modelRegistry.getAvailable = kind => [mock, ...catalogAvailable(kind)];
	const settings = Settings.isolated({
		"advisor.enabled": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"memory.backend": "off",
		"mnemopi.autoRecall": false,
		"mnemopi.autoRetain": false,
		"mnemopi.llmMode": "none",
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"task.agentIdleTtlMs": 0,
		modelRoles: { default: "mock/mock-model" },
	});
	try {
		for (let index = 0; index < options.cycles; index++) {
			const id = `${path.basename(rootDir)}-startup-${index}`;
			const invocationId = `task-startup:${childCount}:${index}`;
			emit("task-startup:begin", invocationId, { bytesConsumed: 0, recordsVisited: 0, resultCount: childCount });
			const result = await runSubprocess({
				cwd: rootDir,
				artifactsDir: rootDir,
				agent: {
					name: "task",
					description: "Synthetic task agent",
					systemPrompt: "Complete the synthetic task.",
					tools: ["write"],
					source: "bundled",
				},
				task: "Complete the synthetic task.",
				assignment: "Complete the synthetic task.",
				index,
				id,
				parentAgentId: "Main",
				keepAlive: false,
				structured: false,
				modelOverride: "mock/mock-model",
				authStorage,
				modelRegistry,
				settings,
				enableIrc: true,
				enableLsp: false,
				enableMCP: false,
				contextFiles: [],
				skills: [],
				rules: [],
				promptTemplates: [],
				workspaceTree: {
					rootPath: rootDir,
					rendered: "synthetic workspace",
					truncated: false,
					totalLines: 1,
					agentsMdFiles: [],
				},
			});
			if (result.exitCode !== 0 || result.output !== "synthetic completion") {
				throw new Error(`mock task startup did not complete: ${result.stderr || result.output}`);
			}
			if (AgentRegistry.global().get(id) !== undefined) {
				throw new Error("completed mock task retained a live registry session");
			}
			emit("task-startup:complete", invocationId, {
				bytesConsumed: 0,
				recordsVisited: 0,
				resultCount: childCount,
			});
			await settle();
			emit("task-startup:disposed", invocationId, {
				bytesConsumed: 0,
				recordsVisited: 0,
				resultCount: childCount,
			});
		}
	} finally {
		authStorage.close();
	}
}

async function runTaskStartup(dir: string, options: ProbeOptions): Promise<void> {
	const source = "task-launch-memory-probe";
	registerMockApi(source);
	try {
		await runTaskStartupControl(path.join(dir, "startup-empty.jsonl"), 0, options);
		await runTaskStartupControl(path.join(dir, "startup-populated.jsonl"), options.children, options);
	} finally {
		unregisterCustomApis(source);
	}
}

async function runRenderControl(): Promise<void> {
	await initTheme();
	const progress: AgentProgress = {
		id: "Synthetic",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Synthetic render control",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
	const sessions: ObservableSession[] = Array.from({ length: 16 }, (_, index) => ({
		kind: "subagent",
		label: `Synthetic${index}`,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		id: `Synthetic${index}`,
		agent: "task",
		description: "Synthetic render control",
		progress: { ...progress, id: `Synthetic${index}`, index },
	}));
	emit("render:begin", "render", { bytesConsumed: 0, recordsVisited: 0, resultCount: sessions.length });
	const rendered = Bun.stripANSI(renderSubagentHudLines(sessions, 120, false, false).join("\n"));
	if (!rendered.includes("Synthetic0")) throw new Error("task progress renderer omitted a synthetic child");
	emit("render:complete", "render", {
		bytesConsumed: 0,
		recordsVisited: sessions.length,
		resultCount: rendered.length,
	});
	await settle();
	emit("render:disposed", "render", {
		bytesConsumed: 0,
		recordsVisited: sessions.length,
		resultCount: rendered.length,
	});
}

function fillNonCompressible(allocation: Uint8Array): void {
	const block = new Uint8Array(64 * 1024);
	for (let offset = 0; offset < allocation.length; offset += block.length) {
		crypto.getRandomValues(block);
		allocation.set(block.subarray(0, Math.min(block.length, allocation.length - offset)), offset);
	}
}

async function runDummyAllocator(chunkBytes: number): Promise<void> {
	const allocations: Uint8Array[] = [];
	let bytesConsumed = 0;
	emit("dummy:begin", "dummy", { bytesConsumed, recordsVisited: 0, resultCount: 0 });
	for (;;) {
		const allocation = new Uint8Array(chunkBytes);
		fillNonCompressible(allocation);
		allocations.push(allocation);
		bytesConsumed += allocation.byteLength;
		emit("dummy:allocated", "dummy", {
			bytesConsumed,
			recordsVisited: allocations.length,
			resultCount: allocations.length,
		});
		await Bun.sleep(1);
	}
}

async function main(): Promise<void> {
	if (process.env.OMP_TASK_LAUNCH_MEMORY_PROBE !== "1") {
		throw new Error("memory probes must run through run-memory-probe.py");
	}
	const options = parseOptions();
	if (options.mode === "dummy-allocate") {
		await runDummyAllocator(options.chunkBytes);
		return;
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-launch-memory-"));
	try {
		const loaderFile = path.join(dir, "loader.jsonl");
		const rootFile = path.join(dir, "root.jsonl");
		if (options.mode === "loader" || options.mode === "all") {
			await writeLoaderFixture(loaderFile, options.fixtureBytes, options.shape, "loader");
			await runLoader(loaderFile, `loader:${options.shape}:${options.fixtureBytes}`, options.cycles);
		}
		if (options.mode === "roster" || options.mode === "all") await runRoster(rootFile, options);
		if (options.mode === "fresh-session" || options.mode === "all")
			await runFreshSession(dir, path.join(dir, "fresh-parent.jsonl"));
		if (options.mode === "child-setup" || options.mode === "all") {
			const parentFile = path.join(dir, "child-parent.jsonl");
			await writeLoaderFixture(parentFile, options.parentBytes, "normal", "child-parent");
			await runChildSetup(dir, parentFile, options.cycles);
		}
		if (options.mode === "task-startup" || options.mode === "all") await runTaskStartup(dir, options);
		if (options.mode === "render" || options.mode === "all") await runRenderControl();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

void main().catch(error => {
	process.stderr.write(`memory probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
