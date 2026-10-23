import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BoundedMemoryTerminal, BoundedRenderScheduler } from "./helpers/bounded-memory-terminal";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { heapStats } from "bun:jsc";
import { nativeAddonStatus } from "../../natives/native/loader-state.js";

const MIB = 1024 * 1024;
const DEFAULT_FIXTURE_BYTES = 4 * MIB;
const DEFAULT_ENTRIES = 512;
const DEFAULT_CYCLES = 8;
const DEFAULT_FIXTURE_LIMIT = 32 * MIB;
const ABSOLUTE_FIXTURE_LIMIT = 160 * MIB;
const MAX_NORMAL_RECORD_BYTES = 128 * 1024;
const SYNTHETIC_TIMESTAMP = "2026-10-22T00:00:00.000Z";

const STOP_AFTER = ["load", "prompt", "construct", "init", "replay", "wire"] as const;
type StopAfter = (typeof STOP_AFTER)[number];
const PAYLOAD_PLACEMENTS = ["message", "custom", "tool-result"] as const;
type PayloadPlacement = (typeof PAYLOAD_PLACEMENTS)[number];
const GC_MODES = ["natural", "diagnostic"] as const;
type GcMode = (typeof GC_MODES)[number];

interface ProbeOptions {
	readonly stopAfter: StopAfter;
	readonly fixtureBytes: number;
	readonly entries: number;
	readonly cycles: number;
	readonly payloadPlacement: PayloadPlacement;
	readonly gcMode: GcMode;
	readonly replayRestart: boolean;
	readonly clearHistoryHooks: boolean;
	readonly disposeTranscript: boolean;
}

interface FixtureStats {
	readonly sourceBytes: number;
	readonly payloadBytes: number;
	readonly branchEntries: number;
}

interface RuntimeIdentity {
	readonly bunVersion: string;
	readonly bunRevision: string | null;
	readonly nativeAddonPath: string | null;
	readonly nativeAddonVersion: string | null;
	readonly nativeAddonChecksum: string | null;
}

interface ProbeRow {
	readonly timestamp: number;
	readonly pid: number;
	readonly cycle: number;
	readonly stage: string;
	readonly payloadPlacement: PayloadPlacement;
	readonly gcMode: GcMode;
	readonly fixtureBytes: number;
	readonly sourceBytes: number;
	readonly transcriptEntries: number;
	readonly branchEntries: number;
	readonly retainedEntries: number;
	readonly contextMessages: number;
	readonly mountedComponents: number;
	readonly pendingTools: number;
	readonly wireBytes: number;
	readonly largestWriteBytes: number;
	readonly pendingOutputBytes: number;
	readonly frames: number;
	readonly acknowledgements: number;
	readonly stagedDisposals: number;
	readonly jscHeapSize: number;
	readonly jscExtraMemorySize: number;
	readonly jscObjectCount: number;
	readonly jscProtectedObjectCount: number;
	readonly bunVersion: string | null;
	readonly bunRevision: string | null;
	readonly nativeAddonPath: string | null;
	readonly nativeAddonVersion: string | null;
	readonly nativeAddonChecksum: string | null;
}

interface CycleState {
	readonly cycle: number;
	readonly fixture: FixtureStats;
	readonly options: ProbeOptions;
	manager?: SessionManager;
	contextMessages?: number;
	mode?: InteractiveMode;
	terminal?: BoundedMemoryTerminal;
	stagedDisposals?: number;
}

class MetricsWriter {
	readonly #path: string | undefined;
	#handle: fs.FileHandle | undefined;

	private constructor(metricsPath: string | undefined) {
		this.#path = metricsPath;
	}

	static async create(): Promise<MetricsWriter> {
		const writer = new MetricsWriter(process.env.OMP_MEMORY_PROBE_METRICS_PATH);
		if (writer.#path) writer.#handle = await fs.open(writer.#path, "a");
		return writer;
	}

	async write(row: ProbeRow): Promise<void> {
		const line = `${JSON.stringify(row)}\n`;
		if (Buffer.byteLength(line, "utf8") > 4 * 1024)
			throw new Error("memory probe metric exceeded its bounded row size");
		if (this.#handle) {
			await this.#handle.write(line);
			return;
		}
		process.stdout.write(line);
	}

	async close(): Promise<void> {
		await this.#handle?.close();
		this.#handle = undefined;
	}
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

function enumValue<T extends readonly string[]>(flag: string, values: T, fallback: T[number]): T[number] {
	const value = valueFor(flag) ?? fallback;
	if (!values.includes(value)) throw new Error(`${flag} must be one of ${values.join(", ")}`);
	return value as T[number];
}

function parseOptions(): ProbeOptions {
	const fixtureBytes = positiveInteger("--fixture-bytes", DEFAULT_FIXTURE_BYTES);
	const entries = positiveInteger("--entries", DEFAULT_ENTRIES);
	const payloadPlacement = enumValue("--payload", PAYLOAD_PLACEMENTS, "tool-result");
	const replayRestart = !process.argv.includes("--skip-replay-restart");
	const clearHistoryHooks = process.argv.includes("--clear-history-hooks");
	const disposeTranscript = process.argv.includes("--dispose-transcript");
	if (fixtureBytes > ABSOLUTE_FIXTURE_LIMIT) {
		throw new Error(`fixture bytes exceeds absolute ${ABSOLUTE_FIXTURE_LIMIT} byte cap`);
	}
	if (fixtureBytes > DEFAULT_FIXTURE_LIMIT && !process.argv.includes("--allow-larger-fixture")) {
		throw new Error(`fixture bytes above ${DEFAULT_FIXTURE_LIMIT} require --allow-larger-fixture`);
	}
	if (payloadPlacement === "tool-result" && entries % 2 !== 0) {
		throw new Error("--entries must be even for paired tool-result payloads");
	}
	const payloadSlots = payloadPlacement === "tool-result" ? entries / 2 : entries;
	if (Math.ceil(fixtureBytes / payloadSlots) > MAX_NORMAL_RECORD_BYTES) {
		throw new Error(`payload exceeds the ${MAX_NORMAL_RECORD_BYTES} byte normal-record cap`);
	}
	if (replayRestart && entries < 64) throw new Error("replay restart exercise needs at least 64 linked entries");
	return {
		stopAfter: enumValue("--stop-after", STOP_AFTER, "wire"),
		fixtureBytes,
		entries,
		cycles: positiveInteger("--cycles", DEFAULT_CYCLES),
		payloadPlacement,
		gcMode: enumValue("--gc", GC_MODES, "natural"),
		replayRestart,
		clearHistoryHooks,
		disposeTranscript,
	};
}

function payloadFor(bytes: number, seed: number): string {
	if (bytes === 0) return "";
	const raw = new Uint8Array(Math.ceil((bytes * 3) / 4));
	let state = (seed | 0) ^ 0x6d2b79f5;
	for (let index = 0; index < raw.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		raw[index] = state & 0xff;
	}
	return Buffer.from(raw).toString("base64").slice(0, bytes);
}

function sessionHeader(id: string, cwd: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: SYNTHETIC_TIMESTAMP, cwd };
}

function entryFields(id: string, parentId: string | null): Record<string, string | null> {
	return { id, parentId, timestamp: SYNTHETIC_TIMESTAMP };
}

function userMessageEntry(id: string, parentId: string | null, payload: string): Record<string, unknown> {
	return {
		type: "message",
		...entryFields(id, parentId),
		message: { role: "user", content: [{ type: "text", text: payload }], timestamp: 1 },
	};
}

function customEntry(id: string, parentId: string | null, payload: string): Record<string, unknown> {
	return {
		type: "custom",
		...entryFields(id, parentId),
		customType: "memory-probe:non-displayed",
		data: { payload },
	};
}

function assistantToolCallEntry(id: string, parentId: string | null, callId: string): Record<string, unknown> {
	return {
		type: "message",
		...entryFields(id, parentId),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "write", arguments: { path: "probe.txt", content: "" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "memory-probe",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function toolResultEntry(
	id: string,
	parentId: string | null,
	callId: string,
	textPayload: string,
	detailsPayload: string,
): Record<string, unknown> {
	return {
		type: "message",
		...entryFields(id, parentId),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "write",
			content: [{ type: "text", text: textPayload }],
			details: { payload: detailsPayload },
			isError: false,
			timestamp: 1,
		},
	};
}

async function writeJsonLine(handle: fs.FileHandle, value: unknown): Promise<number> {
	const line = `${JSON.stringify(value)}\n`;
	await handle.write(line);
	return Buffer.byteLength(line, "utf8");
}

function payloadSliceBytes(total: number, index: number, count: number): number {
	return Math.floor((total * (index + 1)) / count) - Math.floor((total * index) / count);
}

async function writeFixture(file: string, cwd: string, options: ProbeOptions): Promise<FixtureStats> {
	const handle = await fs.open(file, "w");
	let sourceBytes = 0;
	let parentId: string | null = null;
	let payloadBytes = 0;
	try {
		sourceBytes += await writeJsonLine(handle, sessionHeader("memory-retention-probe", cwd));
		if (options.payloadPlacement === "message") {
			for (let index = 0; index < options.entries; index++) {
				const payload = payloadFor(payloadSliceBytes(options.fixtureBytes, index, options.entries), index + 1);
				payloadBytes += Buffer.byteLength(payload, "utf8");
				const id = `message-${index}`;
				sourceBytes += await writeJsonLine(handle, userMessageEntry(id, parentId, payload));
				parentId = id;
			}
		} else if (options.payloadPlacement === "custom") {
			for (let index = 0; index < options.entries; index++) {
				const payload = payloadFor(payloadSliceBytes(options.fixtureBytes, index, options.entries), index + 1);
				payloadBytes += Buffer.byteLength(payload, "utf8");
				const id = `custom-${index}`;
				sourceBytes += await writeJsonLine(handle, customEntry(id, parentId, payload));
				parentId = id;
			}
		} else {
			const pairs = options.entries / 2;
			for (let index = 0; index < pairs; index++) {
				const pairPayloadBytes = payloadSliceBytes(options.fixtureBytes, index, pairs);
				const textBytes = Math.floor(pairPayloadBytes / 2);
				const detailsBytes = pairPayloadBytes - textBytes;
				const callId = `call-${index}`;
				const callEntryId = `call-entry-${index}`;
				sourceBytes += await writeJsonLine(handle, assistantToolCallEntry(callEntryId, parentId, callId));
				parentId = callEntryId;
				const textPayload = payloadFor(textBytes, index * 2 + 1);
				const detailsPayload = payloadFor(detailsBytes, index * 2 + 2);
				payloadBytes += Buffer.byteLength(textPayload, "utf8") + Buffer.byteLength(detailsPayload, "utf8");
				const resultEntryId = `result-entry-${index}`;
				sourceBytes += await writeJsonLine(
					handle,
					toolResultEntry(resultEntryId, parentId, callId, textPayload, detailsPayload),
				);
				parentId = resultEntryId;
			}
		}
	} finally {
		await handle.close();
	}
	if (payloadBytes !== options.fixtureBytes) {
		throw new Error(`fixture payload mismatch: expected ${options.fixtureBytes}, wrote ${payloadBytes}`);
	}
	return { sourceBytes, payloadBytes, branchEntries: options.entries };
}

function assertLinkedBranch(manager: SessionManager, expectedEntries: number): number {
	const branch = manager.getBranchView();
	if (branch.length !== expectedEntries) {
		throw new Error(`expected ${expectedEntries} active branch entries, got ${branch.length}`);
	}
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index]!;
		const expectedParent = index === 0 ? null : branch[index - 1]!.id;
		if (entry.parentId !== expectedParent) {
			throw new Error(`branch entry ${index} is not linked to its predecessor`);
		}
	}
	return branch.length;
}

async function checksum(pathname: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(pathname).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function runtimeIdentity(): Promise<RuntimeIdentity> {
	const addon = nativeAddonStatus();
	const bunWithRevision = Bun as typeof Bun & { revision?: string };
	return {
		bunVersion: Bun.version,
		bunRevision: bunWithRevision.revision ?? null,
		nativeAddonPath: addon?.path ?? null,
		nativeAddonVersion: addon?.version ?? null,
		nativeAddonChecksum: addon ? await checksum(addon.path) : null,
	};
}

function emptyState(cycle: number, fixture: FixtureStats, options: ProbeOptions): CycleState {
	return { cycle, fixture, options };
}

async function emit(
	metrics: MetricsWriter,
	stage: string,
	state: CycleState,
	runtime?: RuntimeIdentity,
): Promise<void> {
	const heap = heapStats();
	const terminal = state.terminal?.metrics();
	const manager = state.manager;
	const retainedEntries = manager ? manager.getBranchView().length : 0;
	await metrics.write({
		timestamp: Date.now(),
		pid: process.pid,
		cycle: state.cycle,
		stage,
		payloadPlacement: state.options.payloadPlacement,
		gcMode: state.options.gcMode,
		fixtureBytes: state.fixture.payloadBytes,
		sourceBytes: state.fixture.sourceBytes,
		transcriptEntries: retainedEntries,
		branchEntries: retainedEntries,
		retainedEntries,
		contextMessages: state.contextMessages ?? 0,
		mountedComponents: state.mode?.chatContainer.children.length ?? 0,
		pendingTools: state.mode?.pendingTools.size ?? 0,
		wireBytes: terminal?.wireBytes ?? 0,
		largestWriteBytes: terminal?.largestWriteBytes ?? 0,
		pendingOutputBytes: terminal?.pendingOutputBytes ?? 0,
		frames: terminal?.frames ?? 0,
		acknowledgements: terminal?.acknowledgements ?? 0,
		stagedDisposals: state.stagedDisposals ?? 0,
		jscHeapSize: heap.heapSize,
		jscExtraMemorySize: heap.extraMemorySize,
		jscObjectCount: heap.objectCount,
		jscProtectedObjectCount: heap.protectedObjectCount,
		bunVersion: runtime?.bunVersion ?? null,
		bunRevision: runtime?.bunRevision ?? null,
		nativeAddonPath: runtime?.nativeAddonPath ?? null,
		nativeAddonVersion: runtime?.nativeAddonVersion ?? null,
		nativeAddonChecksum: runtime?.nativeAddonChecksum ?? null,
	});
}

async function shouldStopAtBoundary(metrics: MetricsWriter, state: CycleState): Promise<boolean> {
	const stopFile = process.env.OMP_MEMORY_PROBE_STOP_FILE;
	if (!stopFile || !(await Bun.file(stopFile).exists())) return false;
	await emit(metrics, "cooperative-stop", state);
	return true;
}

function createSettings(): Settings {
	return Settings.isolated({
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
	});
}

async function createSession(manager: SessionManager): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const authStorage = await AuthStorage.create(":memory:");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled probe model is unavailable");
	return {
		authStorage,
		session: new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: createSettings(),
			modelRegistry: new ModelRegistry(authStorage),
		}),
	};
}

async function drainRender(scheduler: BoundedRenderScheduler, terminal: BoundedMemoryTerminal): Promise<void> {
	for (let pass = 0; pass < 4; pass++) {
		scheduler.drain();
		await terminal.flush();
	}
}

async function releaseLoadedManager(manager: SessionManager): Promise<void> {
	const beforeClose = manager.getBranchView().length;
	await manager.close();
	if (manager.getBranchView().length !== beforeClose) {
		throw new Error("close released retained entries before terminal disposal");
	}
	manager.releaseRetainedEntries();
	if (manager.getEntries().length !== 0) throw new Error("releaseRetainedEntries did not drop the loaded transcript");
}

async function runCycle(file: string, cwd: string, state: CycleState, metrics: MetricsWriter): Promise<boolean> {
	const manager = await SessionManager.open(file, cwd, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	state.manager = manager;
	assertLinkedBranch(manager, state.fixture.branchEntries);
	await emit(metrics, "load:complete", state);
	if (await shouldStopAtBoundary(metrics, state)) {
		await releaseLoadedManager(manager);
		state.manager = undefined;
		return true;
	}
	if (state.options.stopAfter === "load") {
		await releaseLoadedManager(manager);
		state.manager = undefined;
		await emit(metrics, "disposed", state);
		return false;
	}

	const { session, authStorage } = await createSession(manager);
	let mode: InteractiveMode | undefined;
	try {
		{
			const context = session.buildDisplaySessionContext();
			state.contextMessages = context.messages.length;
			const converted = await session.convertMessagesToLlm(context.messages);
			if (state.options.payloadPlacement !== "custom" && converted.length === 0) {
				throw new Error("data-bearing fixture did not reach prompt conversion");
			}
		}
		await emit(metrics, "prompt:complete", state);
		if (await shouldStopAtBoundary(metrics, state)) return true;
		if (state.options.stopAfter === "prompt") return false;

		const scheduler = new BoundedRenderScheduler();
		const terminal = new BoundedMemoryTerminal(120, 40, { native: state.options.stopAfter === "wire" });
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		mode = new InteractiveMode(
			session,
			"memory-probe",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
		);
		state.mode = mode;
		state.terminal = terminal;
		if (state.options.stopAfter === "construct") {
			await emit(metrics, "construct:complete", state);
			return false;
		}
		await mode.init({ suppressWelcomeIntro: true });
		await drainRender(scheduler, terminal);
		if (state.options.stopAfter === "init") {
			await emit(metrics, "init:complete", state);
			return false;
		}
		if (state.options.stopAfter === "wire" && !mode.ui.nativeRendering) {
			throw new Error("wire probe did not construct the real NativeBackend");
		}
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await drainRender(scheduler, terminal);
		if (state.options.payloadPlacement === "tool-result" && state.mode.pendingTools.size !== 0) {
			throw new Error("paired tool results remained pending after transcript replay");
		}
		await emit(metrics, state.options.stopAfter === "wire" ? "wire:complete" : "replay:complete", state);
		if (await shouldStopAtBoundary(metrics, state)) return true;
		return false;
	} finally {
		if (state.options.disposeTranscript) mode?.chatContainer.disposeChildren();
		mode?.stop();
		if (state.options.clearHistoryHooks) {
			mode?.historyStorage?.setSessionResolver(() => undefined);
			mode?.historyStorage?.setErrorListener(() => {});
		}
		mode = undefined;
		state.mode = undefined;
		state.terminal = undefined;
		await session.dispose();
		authStorage.close();
		if (manager.getEntries().length !== 0) throw new Error("session disposal did not release retained entries");
		state.manager = undefined;
		await emit(metrics, "disposed", state);
	}
}

async function runReplayRestart(
	file: string,
	cwd: string,
	state: CycleState,
	metrics: MetricsWriter,
): Promise<boolean> {
	const manager = await SessionManager.open(file, cwd, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	state.manager = manager;
	assertLinkedBranch(manager, state.fixture.branchEntries);
	const { session, authStorage } = await createSession(manager);
	const scheduler = new BoundedRenderScheduler();
	const terminal = new BoundedMemoryTerminal(120, 40, { native: state.options.stopAfter === "wire" });
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true },
	});
	let mode: InteractiveMode | undefined = new InteractiveMode(
		session,
		"memory-probe",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		composer,
	);
	state.mode = mode;
	state.terminal = terminal;
	let stagedDisposals = 0;
	try {
		await mode.init({ suppressWelcomeIntro: true });
		await drainRender(scheduler, terminal);
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await drainRender(scheduler, terminal);
		const originalRender = mode.renderSessionContextIncrementally.bind(mode);
		let appended = false;
		mode.renderSessionContextIncrementally = async (context, options, renderChunk) =>
			await originalRender(context, options, () => {
				if (!appended) {
					manager.appendMessage({ role: "user", content: "replay restart proof", timestamp: Date.now() });
					appended = true;
				}
				renderChunk?.();
			});
		const disposeChildren = TranscriptContainer.prototype.disposeChildren;
		TranscriptContainer.prototype.disposeChildren = function (this: TranscriptContainer): void {
			stagedDisposals++;
			disposeChildren.call(this);
		};
		try {
			await mode.renderInitialMessages({ clearTerminalHistory: true });
			await drainRender(scheduler, terminal);
		} finally {
			TranscriptContainer.prototype.disposeChildren = disposeChildren;
		}
		state.stagedDisposals = stagedDisposals;
		if (!appended) throw new Error("replay restart did not append during an incremental yield");
		if (stagedDisposals < 2) throw new Error("replay restart did not discard the rejected staged transcript");
		if (manager.getBranchView().length !== state.fixture.branchEntries + 1) {
			throw new Error("replay restart did not accept the persisted replacement entry");
		}
		await emit(metrics, "replay-restart:complete", state);
		return await shouldStopAtBoundary(metrics, state);
	} finally {
		if (state.options.disposeTranscript) mode?.chatContainer.disposeChildren();
		mode?.stop();
		if (state.options.clearHistoryHooks) {
			mode?.historyStorage?.setSessionResolver(() => undefined);
			mode?.historyStorage?.setErrorListener(() => {});
		}
		mode = undefined;
		state.mode = undefined;
		state.terminal = undefined;
		await session.dispose();
		authStorage.close();
		if (manager.getEntries().length !== 0)
			throw new Error("replay restart disposal did not release retained entries");
		state.manager = undefined;
		await emit(metrics, "replay-restart:disposed", state);
	}
}

async function diagnosticCollect(metrics: MetricsWriter, state: CycleState): Promise<void> {
	if (state.options.gcMode !== "diagnostic") return;
	Bun.gc(true);
	await Bun.sleep(0);
	Bun.gc(true);
	await emit(metrics, "post-gc", state);
}

async function verifyRestartPersistence(file: string, cwd: string, expectedEntries: number): Promise<void> {
	const reopened = await SessionManager.open(file, cwd, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		assertLinkedBranch(reopened, expectedEntries);
	} finally {
		await releaseLoadedManager(reopened);
	}
}

async function main(): Promise<void> {
	if (process.env.OMP_SESSION_RETENTION_MEMORY_PROBE !== "1") {
		throw new Error("session retention probe must run through run-memory-probe.py");
	}
	const options = parseOptions();
	const metrics = await MetricsWriter.create();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-retention-memory-"));
	try {
		await Settings.init({ inMemory: true, cwd: dir });
		await initTheme();
		const sourceFile = path.join(dir, "session.jsonl");
		const fixture = await writeFixture(sourceFile, dir, options);
		const runtime = await runtimeIdentity();
		await emit(metrics, "runtime", emptyState(0, fixture, options), runtime);
		for (let cycle = 1; cycle <= options.cycles; cycle++) {
			const state = emptyState(cycle, fixture, options);
			const cycleFile = path.join(dir, `cycle-${cycle}.jsonl`);
			await fs.copyFile(sourceFile, cycleFile);
			await emit(metrics, "cycle:begin", state);
			const stopped = await runCycle(cycleFile, dir, state, metrics);
			await diagnosticCollect(metrics, state);
			if (stopped || (await shouldStopAtBoundary(metrics, state))) return;
		}
		if (options.replayRestart && (options.stopAfter === "replay" || options.stopAfter === "wire")) {
			const state = emptyState(options.cycles + 1, fixture, options);
			const restartFile = path.join(dir, "replay-restart.jsonl");
			await fs.copyFile(sourceFile, restartFile);
			const stopped = await runReplayRestart(restartFile, dir, state, metrics);
			await diagnosticCollect(metrics, state);
			if (stopped || (await shouldStopAtBoundary(metrics, state))) return;
			await verifyRestartPersistence(restartFile, dir, fixture.branchEntries + 2);
		}
	} finally {
		await metrics.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

void main().catch(error => {
	process.stderr.write(
		`session retention memory probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
