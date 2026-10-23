import { heapStats } from "bun:jsc";
import { writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { beginEventStreamProbe, eventStreamProbeMetrics } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	beginOpenAIRequestPreparationProbe,
	type OpenAIRequestPreparationPhase,
} from "@oh-my-pi/pi-ai/utils/openai-http";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CustomTool } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ToolExecutionComponent, type ToolExecutionProbeMetrics } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { nativeAddonStatus } from "../../natives/native/loader-state.js";
import {
	INCIDENT_FIXTURE_BYTES,
	INCIDENT_FIXTURE_ENTRIES,
	INCIDENT_FIXTURE_LINKED_TAIL_ID,
	INCIDENT_FIXTURE_PNG_BASE64,
	verifyIncidentMemoryFixture,
	type IncidentFixtureVerification,
} from "./helpers/incident-memory-fixture";

const MIB = 1024 * 1024;
const LIVE_WRITE_HTML_BYTES = 2 * MIB;
const ARGUMENT_DELTA_BYTES = 8 * 1024;
const PROBE_REPLACEMENT_COUNT = 8;
const PROBE_RESULT_TEXT_BYTES = 256 * 1024;
const PROBE_DETAILS_BYTES = MIB;
const MAX_REQUEST_PREPARATION_SNAPSHOTS = 4;
const FINAL_SENTINEL = "incident-memory:complete";
const FINAL_COMPLETION = `${FINAL_SENTINEL} synthetic loopback final completion`;
const incidentReplacementParameters = type({ turn: "number" });

type Arm = "engine-only" | "native";
type Collection = "passive" | "heapStats" | "gc";

type DiagnosticHeap = {
	readonly heapSize: number;
	readonly extraMemorySize: number;
	readonly objectCount: number;
	readonly protectedObjectCount: number;
};

type RequestPreparationSnapshot = {
	readonly phase: string;
	readonly inputItemCount: number;
	readonly toolCount: number;
	readonly serializedCodeUnits: number;
};

interface ProbeOptions {
	readonly arm: Arm;
	readonly fixtureFile: string;
	readonly fixtureChecksum: string;
}

interface IncidentProbeRow {
	readonly kind: "incident-memory-attribution";
	readonly timestamp: number;
	readonly pid: number;
	readonly arm: Arm;
	readonly stage: string;
	readonly collection: Collection;
	readonly fixtureChecksum: string;
	readonly fixtureBytes: number;
	readonly fixtureEntries: number;
	readonly fixtureLinkedTailId: string;
	readonly restoredEntries: number;
	readonly agentMessageCount: number;
	readonly managerMessagePayloadBytes: number;
	readonly agentMessagePayloadBytes: number;
	readonly sharedManagerAgentMessageCount: number;
	readonly builtinToolCount: number;
	readonly enabledToolCount: number;
	readonly ruleCount: number;
	readonly contextFileCount: number;
	readonly promptBytes: number;
	readonly requestPreparationPhase: string;
	readonly requestPreparationInputItems: number;
	readonly requestPreparationToolCount: number;
	readonly requestPreparationSerializedCodeUnits: number;
	readonly requestCount: number;
	readonly requestBytes: number;
	readonly providerDeltaBytes: number;
	readonly cumulativeArgumentBytes: number;
	readonly serializedTurns: number;
	readonly verifiedWriteCount: number;
	readonly finalResultCount: number;
	readonly replacementResultsObserved: number;
	readonly queueOutstandingEvents: number;
	readonly queueOutstandingPayloadBytes: number;
	readonly queueHighWaterEvents: number;
	readonly queueHighWaterPayloadBytes: number;
	readonly queueEnqueuedEvents: number;
	readonly queueDequeuedEvents: number;
	readonly revealEntryCount: number;
	readonly revealTargetBytes: number;
	readonly revealPrefixBytes: number;
	readonly revealParsedArgumentBytes: number;
	readonly revealDisplayArgumentBytes: number;
	readonly toolArgumentBytes: number;
	readonly toolResultTextBytes: number;
	readonly toolDetailsBytes: number;
	readonly toolImageBytes: number;
	readonly modeConstructs: number;
	readonly modeStops: number;
	readonly tuiStops: number;
	readonly nativeComponentStates: number;
	readonly nativeIdStates: number;
	readonly nativeFramesSent: number;
	readonly nativeFramesAcknowledged: number;
	readonly nativeUnackedFrames: number;
	readonly nativePendingBlobCount: number;
	readonly nativePendingBlobBytes: number;
	readonly nativePendingOutputBytes: number;
	readonly terminalWireBytes: number;
	readonly terminalLargestWriteBytes: number;
	readonly heapUsed: number;
	readonly heapTotal: number;
	readonly external: number;
	readonly arrayBuffers: number;
	readonly rss: number;
	readonly diagnosticHeapSize: number;
	readonly diagnosticExtraMemorySize: number;
	readonly diagnosticObjectCount: number;
	readonly diagnosticProtectedObjectCount: number;
}

class MetricsWriter {
	readonly #path: string | undefined;
	#handle: fs.FileHandle | undefined;
	#tail: Promise<void> = Promise.resolve();

	private constructor(metricsPath: string | undefined) {
		this.#path = metricsPath;
	}

	static async create(): Promise<MetricsWriter> {
		const writer = new MetricsWriter(process.env.OMP_MEMORY_PROBE_METRICS_PATH);
		if (writer.#path) writer.#handle = await fs.open(writer.#path, "a");
		return writer;
	}

	#serialize(row: IncidentProbeRow): string {
		const line = `${JSON.stringify(row)}\n`;
		if (Buffer.byteLength(line, "utf8") > 4 * 1024) {
			throw new Error("incident attribution metric exceeded its bounded row size");
		}
		return line;
	}

	async write(row: IncidentProbeRow): Promise<void> {
		const line = this.#serialize(row);
		this.#tail = this.#tail.then(async () => {
			if (this.#handle) {
				await this.#handle.write(line);
				return;
			}
			process.stdout.write(line);
		});
		await this.#tail;
	}

	writeImmediately(row: IncidentProbeRow): void {
		const line = this.#serialize(row);
		if (this.#handle) {
			writeSync(this.#handle.fd, line);
			return;
		}
		process.stdout.write(line);
	}

	async close(): Promise<void> {
		await this.#tail;
		await this.#handle?.close();
		this.#handle = undefined;
	}
}

function requiredValue(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
	return value;
}

function parseOptions(): ProbeOptions {
	if (process.env.OMP_INCIDENT_MEMORY_ATTRIBUTION_PROBE !== "1") {
		throw new Error("incident attribution probe must run through run-memory-probe.py");
	}
	if (requiredValue("--scenario") !== "incident-memory-attribution") {
		throw new Error("incident attribution probe requires --scenario incident-memory-attribution");
	}
	const arm = requiredValue("--arm");
	if (arm !== "engine-only" && arm !== "native") throw new Error("--arm must be engine-only or native");
	const fixtureChecksum = requiredValue("--fixture-checksum");
	if (!/^[0-9a-f]{64}$/.test(fixtureChecksum)) throw new Error("--fixture-checksum must be a SHA-256 hex digest");
	return { arm, fixtureFile: path.resolve(requiredValue("--fixture")), fixtureChecksum };
}

function hashText(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function hashFile(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

function asciiPayload(bytes: number, seed: number): string {
	if (bytes < 0) throw new Error(`negative payload budget: ${bytes}`);
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const characters = new Array<string>(bytes);
	let value = (seed | 0) ^ 0x6d2b79f5;
	for (let index = 0; index < bytes; index++) {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		characters[index] = alphabet.charAt((value >>> 0) % alphabet.length);
	}
	return characters.join("");
}

function sizedText(prefix: string, bytes: number, seed: number): string {
	const prefixBytes = Buffer.byteLength(prefix, "utf8");
	if (prefixBytes > bytes) throw new Error("probe payload prefix exceeds its byte budget");
	return `${prefix}${asciiPayload(bytes - prefixBytes, seed)}`;
}

function liveWriteHtml(): string {
	const prefix = `<!doctype html>\n<html><body data-origin="incident">\n<img src="data:image/png;base64,${INCIDENT_FIXTURE_PNG_BASE64}">\n<section>`;
	const suffix = "</section>\n</body></html>";
	return `${prefix}${asciiPayload(LIVE_WRITE_HTML_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix), 71)}${suffix}`;
}

function logicalValueBytes(value: unknown, seen = new Set<object>()): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (value === null || typeof value !== "object") return 0;
	if (seen.has(value)) return 0;
	seen.add(value);
	if (Array.isArray(value)) {
		let bytes = 0;
		for (const item of value) bytes += logicalValueBytes(item, seen);
		return bytes;
	}
	let bytes = 0;
	for (const item of Object.values(value)) bytes += logicalValueBytes(item, seen);
	return bytes;
}

function streamedEventBytes(event: unknown): number {
	if (!isRecord(event)) return 0;
	const delta = event.delta;
	return typeof delta === "string" ? Buffer.byteLength(delta, "utf8") : 0;
}

function toolArgumentsContentBytes(value: unknown): number {
	if (!isRecord(value)) return logicalValueBytes(value);
	const content = value.content;
	return typeof content === "string" ? Buffer.byteLength(content, "utf8") : logicalValueBytes(value);
}

function retainedMessagePayloadBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) {
		let bytes = 0;
		for (const item of value) bytes += retainedMessagePayloadBytes(item);
		return bytes;
	}
	let bytes = 0;
	for (const key in value) bytes += retainedMessagePayloadBytes((value as Record<string, unknown>)[key]);
	return bytes;
}

function zeroToolMetrics(): ToolExecutionProbeMetrics {
	return { argumentBytes: 0, resultTextBytes: 0, detailsBytes: 0, imageBytes: 0 };
}

function createSyntheticRule(cwd: string): Rule {
	return {
		name: "incident-memory-attribution",
		path: path.join(cwd, "incident-memory-attribution.rule.md"),
		content: "Use the supplied loopback provider and only the active synthetic tools.",
		alwaysApply: true,
		_source: {
			provider: "incident-memory-attribution",
			providerName: "Incident memory attribution",
			path: path.join(cwd, "incident-memory-attribution.rule.md"),
			level: "project",
		},
	};
}

function localResponsesModel(baseUrl: string): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "Incident loopback Responses",
		id: "incident-loopback",
		provider: "openai",
		baseUrl,
		contextWindow: 1_000_000_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies ModelSpec<"openai-responses">);
}

function sseFrame(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

class LoopbackResponses {
	readonly #workspace: string;
	#requestCount = 0;
	#requestBytes = 0;
	#providerDeltaBytes = 0;
	readonly #requestHashes: string[] = [];
	readonly #expectedWrites: Map<string, string>;

	constructor(workspace: string, expectedWrites: Map<string, string>) {
		this.#workspace = workspace;
		this.#expectedWrites = expectedWrites;
	}

	get requestCount(): number {
		return this.#requestCount;
	}

	get requestBytes(): number {
		return this.#requestBytes;
	}

	get providerDeltaBytes(): number {
		return this.#providerDeltaBytes;
	}

	get requestHashes(): readonly string[] {
		return this.#requestHashes;
	}

	async fetch(request: Request): Promise<Response> {
		const hasher = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		const reader = request.body?.getReader();
		if (reader) {
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					if (next.value) {
						bytes += next.value.byteLength;
						hasher.update(next.value);
					}
				}
			} finally {
				reader.releaseLock();
			}
		}
		this.#requestCount++;
		this.#requestBytes += bytes;
		this.#requestHashes.push(hasher.digest("hex"));
		if (this.#requestHashes.length > 4) throw new Error("loopback received more than four serialized turns");
		switch (this.#requestCount) {
			case 1:
				return this.#streamedWriteResponse();
			case 2:
				return this.#functionCallResponse("incident_replacement", "incident-replacement-call", { turn: 2 });
			case 3:
				return this.#smallWriteResponse();
			case 4:
				return this.#completionResponse();
			default:
				return new Response("unexpected loopback request", { status: 500 });
		}
	}

	#streamedWriteResponse(): Response {
		const content = liveWriteHtml();
		if (Buffer.byteLength(content, "utf8") !== LIVE_WRITE_HTML_BYTES) {
			throw new Error("live write HTML did not meet its two MiB budget");
		}
		const file = path.join(this.#workspace, "streamed-live.html");
		this.#expectedWrites.set(file, hashText(content));
		return this.#functionCallResponse(
			"write",
			"incident-streamed-write",
			{ path: file, content },
			ARGUMENT_DELTA_BYTES,
		);
	}

	#smallWriteResponse(): Response {
		const content = "incident turn three write\n";
		const file = path.join(this.#workspace, "turn-three.txt");
		this.#expectedWrites.set(file, hashText(content));
		return this.#functionCallResponse("write", "incident-turn-three-write", { path: file, content });
	}

	#functionCallResponse(
		name: string,
		callId: string,
		argumentsValue: Record<string, unknown>,
		deltaBytes = ARGUMENT_DELTA_BYTES,
	): Response {
		let argumentsText = JSON.stringify(argumentsValue);
		let offset = 0;
		let phase = 0;
		const item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name };
		const responseId = `response_${callId}`;
		const stream = new ReadableStream<Uint8Array>({
			pull: controller => {
				if (phase === 0) {
					phase++;
					controller.enqueue(
						sseFrame({ type: "response.created", response: { id: responseId, status: "in_progress" } }),
					);
					return;
				}
				if (phase === 1) {
					phase++;
					controller.enqueue(
						sseFrame({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }),
					);
					return;
				}
				if (offset < argumentsText.length) {
					const delta = argumentsText.slice(offset, offset + deltaBytes);
					offset += delta.length;
					this.#providerDeltaBytes += Buffer.byteLength(delta, "utf8");
					controller.enqueue(
						sseFrame({
							type: "response.function_call_arguments.delta",
							item_id: item.id,
							output_index: 0,
							delta,
						}),
					);
					return;
				}
				if (phase === 1) throw new Error("loopback argument stream did not initialize");
				if (phase === 2) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.function_call_arguments.done",
							item_id: item.id,
							output_index: 0,
							arguments: argumentsText,
						}),
					);
					return;
				}
				if (phase === 3) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.output_item.done",
							output_index: 0,
							item: { ...item, arguments: argumentsText },
						}),
					);
					argumentsText = "";
					return;
				}
				if (phase === 4) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						}),
					);
					return;
				}
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	#completionResponse(): Response {
		let phase = 0;
		const responseId = "response_incident_complete";
		const item = { type: "message", id: "message_incident_complete", role: "assistant" };
		const stream = new ReadableStream<Uint8Array>({
			pull: controller => {
				if (phase === 0) {
					phase++;
					controller.enqueue(
						sseFrame({ type: "response.created", response: { id: responseId, status: "in_progress" } }),
					);
					return;
				}
				if (phase === 1) {
					phase++;
					controller.enqueue(
						sseFrame({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }),
					);
					return;
				}
				if (phase === 2) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.output_text.delta",
							output_index: 0,
							item_id: item.id,
							delta: FINAL_COMPLETION,
						}),
					);
					return;
				}
				if (phase === 3) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.output_item.done",
							output_index: 0,
							item: { ...item, status: "completed", content: [{ type: "output_text", text: FINAL_COMPLETION }] },
						}),
					);
					return;
				}
				if (phase === 4) {
					phase++;
					controller.enqueue(
						sseFrame({
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						}),
					);
					return;
				}
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
}

class AttributionState {
	readonly options: ProbeOptions;
	readonly fixture: IncidentFixtureVerification;
	readonly metrics: MetricsWriter;
	readonly expectedWriteHashes = new Map<string, string>();
	readonly verifiedWriteHashes = new Map<string, string>();
	workspace = "";
	loopback: LoopbackResponses | undefined;
	manager: SessionManager | undefined;
	mode: InteractiveMode | undefined;
	terminal: ProcessTerminal | undefined;
	restoredEntries = 0;
	agentMessageCount = 0;
	managerMessagePayloadBytes = 0;
	agentMessagePayloadBytes = 0;
	sharedManagerAgentMessageCount = 0;
	builtinToolCount = 0;
	enabledToolCount = 0;
	ruleCount = 0;
	contextFileCount = 0;
	promptBytes = 0;
	cumulativeArgumentBytes = 0;
	replacementResultsObserved = 0;
	finalResultCount = 0;
	modeConstructs = 0;
	modeStops = 0;
	tuiStops = 0;
	toolMetrics: ToolExecutionProbeMetrics = zeroToolMetrics();
	observerError: Error | undefined;
	requestPreparationSnapshots = 0;

	constructor(options: ProbeOptions, fixture: IncidentFixtureVerification, metrics: MetricsWriter) {
		this.options = options;
		this.fixture = fixture;
		this.metrics = metrics;
	}

	refreshMessageOwnership(session?: AgentSession): void {
		const agentMessages = session?.agent.state.messages ?? [];
		let managerMessagePayloadBytes = 0;
		let agentMessagePayloadBytes = 0;
		let sharedManagerAgentMessageCount = 0;
		for (const message of agentMessages) agentMessagePayloadBytes += retainedMessagePayloadBytes(message);
		let messageIndex = 0;
		for (const entry of this.manager?.getBranchView() ?? []) {
			if (entry.type !== "message") continue;
			managerMessagePayloadBytes += retainedMessagePayloadBytes(entry.message);
			if (agentMessages[messageIndex] === entry.message) sharedManagerAgentMessageCount++;
			messageIndex++;
		}
		this.managerMessagePayloadBytes = managerMessagePayloadBytes;
		this.agentMessagePayloadBytes = agentMessagePayloadBytes;
		this.sharedManagerAgentMessageCount = sharedManagerAgentMessageCount;
	}

	captureToolComponent(toolCallId: string): void {
		const component = this.mode?.pendingTools.get(toolCallId);
		if (component instanceof ToolExecutionComponent) this.toolMetrics = component.getProbePayloadMetrics();
	}

	observe(event: { type: string; assistantMessageEvent?: unknown; toolCallId?: string; args?: unknown }): void {
		if (event.type === "message_update") {
			this.cumulativeArgumentBytes += streamedEventBytes(event.assistantMessageEvent);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.toolMetrics = { ...this.toolMetrics, argumentBytes: toolArgumentsContentBytes(event.args) };
			if (event.toolCallId) this.captureToolComponent(event.toolCallId);
		}
	}

	#row(
		stage: string,
		collection: Collection,
		diagnostic?: DiagnosticHeap,
		preparation?: RequestPreparationSnapshot,
	): IncidentProbeRow {
		const memory = process.memoryUsage();
		const queue = eventStreamProbeMetrics();
		const reveal = this.mode?.eventController.getToolArgsRevealProbeMetrics();
		const native = this.mode?.ui.getNativeProbeMetrics();
		const terminal = this.terminal?.getProbeMetrics();
		return {
			kind: "incident-memory-attribution",
			timestamp: Date.now(),
			pid: process.pid,
			arm: this.options.arm,
			stage,
			collection,
			fixtureChecksum: this.fixture.checksum,
			fixtureBytes: this.fixture.sourceBytes,
			fixtureEntries: this.fixture.entryCount,
			fixtureLinkedTailId: this.fixture.linkedTailId,
			restoredEntries: this.restoredEntries,
			agentMessageCount: this.agentMessageCount,
			managerMessagePayloadBytes: this.managerMessagePayloadBytes,
			agentMessagePayloadBytes: this.agentMessagePayloadBytes,
			sharedManagerAgentMessageCount: this.sharedManagerAgentMessageCount,
			builtinToolCount: this.builtinToolCount,
			enabledToolCount: this.enabledToolCount,
			ruleCount: this.ruleCount,
			contextFileCount: this.contextFileCount,
			promptBytes: this.promptBytes,
			requestPreparationPhase: preparation?.phase ?? "",
			requestPreparationInputItems: preparation?.inputItemCount ?? 0,
			requestPreparationToolCount: preparation?.toolCount ?? 0,
			requestPreparationSerializedCodeUnits: preparation?.serializedCodeUnits ?? 0,
			requestCount: this.loopback?.requestCount ?? 0,
			requestBytes: this.loopback?.requestBytes ?? 0,
			providerDeltaBytes: this.loopback?.providerDeltaBytes ?? 0,
			cumulativeArgumentBytes: this.cumulativeArgumentBytes,
			serializedTurns: this.loopback?.requestCount ?? 0,
			verifiedWriteCount: this.verifiedWriteHashes.size,
			finalResultCount: this.finalResultCount,
			replacementResultsObserved: this.replacementResultsObserved,
			queueOutstandingEvents: queue?.queuedEvents ?? 0,
			queueOutstandingPayloadBytes: queue?.queuedPayloadBytes ?? 0,
			queueHighWaterEvents: queue?.queueHighWaterEvents ?? 0,
			queueHighWaterPayloadBytes: queue?.queueHighWaterPayloadBytes ?? 0,
			queueEnqueuedEvents: queue?.enqueuedEvents ?? 0,
			queueDequeuedEvents: queue?.dequeuedEvents ?? 0,
			revealEntryCount: reveal?.entryCount ?? 0,
			revealTargetBytes: reveal?.targetBytes ?? 0,
			revealPrefixBytes: reveal?.revealedPrefixBytes ?? 0,
			revealParsedArgumentBytes: reveal?.parsedArgumentBytes ?? 0,
			revealDisplayArgumentBytes: reveal?.displayArgumentBytes ?? 0,
			toolArgumentBytes: this.toolMetrics.argumentBytes,
			toolResultTextBytes: this.toolMetrics.resultTextBytes,
			toolDetailsBytes: this.toolMetrics.detailsBytes,
			toolImageBytes: this.toolMetrics.imageBytes,
			modeConstructs: this.modeConstructs,
			modeStops: this.modeStops,
			tuiStops: this.tuiStops,
			nativeComponentStates: native?.componentStates ?? 0,
			nativeIdStates: native?.idStates ?? 0,
			nativeFramesSent: native?.framesSent ?? 0,
			nativeFramesAcknowledged: native?.framesAcknowledged ?? 0,
			nativeUnackedFrames: native?.unackedFrames ?? 0,
			nativePendingBlobCount: native?.pendingBlobCount ?? 0,
			nativePendingBlobBytes: native?.pendingBlobBytes ?? 0,
			nativePendingOutputBytes: terminal?.pendingOutputBytes ?? 0,
			terminalWireBytes: terminal?.wireBytes ?? 0,
			terminalLargestWriteBytes: terminal?.largestWriteBytes ?? 0,
			heapUsed: memory.heapUsed,
			heapTotal: memory.heapTotal,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
			rss: memory.rss,
			diagnosticHeapSize: diagnostic?.heapSize ?? 0,
			diagnosticExtraMemorySize: diagnostic?.extraMemorySize ?? 0,
			diagnosticObjectCount: diagnostic?.objectCount ?? 0,
			diagnosticProtectedObjectCount: diagnostic?.protectedObjectCount ?? 0,
		};
	}

	async emit(
		stage: string,
		collection: Collection = "passive",
		diagnostic?: DiagnosticHeap,
		preparation?: RequestPreparationSnapshot,
	): Promise<void> {
		await this.metrics.write(this.#row(stage, collection, diagnostic, preparation));
	}

	recordRequestPreparation(
		phase: OpenAIRequestPreparationPhase,
		inputItemCount: number,
		toolCount: number,
		serializedCodeUnits: number,
	): void {
		if (this.requestPreparationSnapshots >= MAX_REQUEST_PREPARATION_SNAPSHOTS) return;
		this.requestPreparationSnapshots++;
		try {
			this.metrics.writeImmediately(
				this.#row(`incident:request-preparation:${phase}`, "passive", undefined, {
					phase,
					inputItemCount,
					toolCount,
					serializedCodeUnits,
				}),
			);
		} catch (error) {
			this.observerError ??= error instanceof Error ? error : new Error(String(error));
		}
	}

	schedule(stage: string): void {
		void this.emit(stage).catch(error => {
			this.observerError ??= error instanceof Error ? error : new Error(String(error));
		});
	}
}

function imageDataFromDetails(details: unknown): string[] {
	const values: string[] = [];
	if (!isRecord(details)) return values;
	if (Array.isArray(details.images)) {
		for (const image of details.images) {
			if (isRecord(image) && typeof image.data === "string") values.push(image.data);
		}
	}
	if (isRecord(details.xdev) && isRecord(details.xdev.inner) && Array.isArray(details.xdev.inner.images)) {
		for (const image of details.xdev.inner.images) {
			if (isRecord(image) && typeof image.data === "string") values.push(image.data);
		}
	}
	return values;
}

function assertRestoredFixture(messages: readonly AgentMessage[], fixture: IncidentFixtureVerification): void {
	if (messages.length !== INCIDENT_FIXTURE_ENTRIES) {
		throw new Error(`SDK restored ${messages.length} messages, expected ${INCIDENT_FIXTURE_ENTRIES}`);
	}
	const largeCallHashes = new Map<string, string>();
	const selectedTextHashes = new Map<string, string>();
	const selectedDetailsHashes = new Map<string, string>();
	let contentImages = 0;
	let detailImages = 0;
	let xdevImages = 0;
	for (const message of messages) {
		const record: unknown = message;
		if (!isRecord(record)) continue;
		if (record.role === "assistant" && Array.isArray(record.content)) {
			for (const block of record.content) {
				if (
					!isRecord(block) ||
					block.type !== "toolCall" ||
					typeof block.id !== "string" ||
					!isRecord(block.arguments)
				) {
					continue;
				}
				const content = block.arguments.content;
				if (typeof content === "string" && Buffer.byteLength(content, "utf8") === 2 * MIB) {
					largeCallHashes.set(block.id, hashText(content));
				}
			}
			continue;
		}
		if (record.role !== "toolResult" || typeof record.toolCallId !== "string" || !Array.isArray(record.content))
			continue;
		const text = record.content[0];
		if (isRecord(text) && typeof text.text === "string") {
			if (Object.hasOwn(fixture.selectedResultTextHashes, record.toolCallId)) {
				selectedTextHashes.set(record.toolCallId, hashText(text.text));
			}
		}
		for (const block of record.content) {
			if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string") continue;
			if (hashText(block.data) !== fixture.imageHash) throw new Error("restored content image hash changed");
			contentImages++;
		}
		if (isRecord(record.details)) {
			if (
				Object.hasOwn(fixture.selectedDetailsHashes, record.toolCallId) &&
				typeof record.details.payload === "string"
			) {
				selectedDetailsHashes.set(record.toolCallId, hashText(record.details.payload));
			}
			if (Array.isArray(record.details.images)) detailImages += record.details.images.length;
			if (
				isRecord(record.details.xdev) &&
				isRecord(record.details.xdev.inner) &&
				Array.isArray(record.details.xdev.inner.images)
			) {
				xdevImages += record.details.xdev.inner.images.length;
			}
			for (const data of imageDataFromDetails(record.details)) {
				if (hashText(data) !== fixture.imageHash) throw new Error("restored detail image hash changed");
			}
		}
	}
	for (const [callId, expected] of Object.entries(fixture.largeWriteArgumentHashes)) {
		if (largeCallHashes.get(callId) !== expected) throw new Error(`restored large write ${callId} changed`);
	}
	for (const [callId, expected] of Object.entries(fixture.selectedResultTextHashes)) {
		if (selectedTextHashes.get(callId) !== expected) throw new Error(`restored result text ${callId} changed`);
	}
	for (const [callId, expected] of Object.entries(fixture.selectedDetailsHashes)) {
		if (selectedDetailsHashes.get(callId) !== expected) throw new Error(`restored details ${callId} changed`);
	}
	if (contentImages === 0 || detailImages === 0 || xdevImages === 0) {
		throw new Error("restored fixture did not retain images in every required supported position");
	}
}

async function verifyWrites(state: AttributionState): Promise<void> {
	if (state.expectedWriteHashes.size !== 4) {
		throw new Error(`expected ${state.expectedWriteHashes.size} temporary writes, expected four`);
	}
	for (const [file, expected] of state.expectedWriteHashes) {
		const actual = await hashFile(file);
		if (actual !== expected) throw new Error(`temporary write hash changed for ${path.basename(file)}`);
		state.verifiedWriteHashes.set(file, actual);
	}
}

async function verifyPersistence(file: string, cwd: string): Promise<void> {
	const reopened = await SessionManager.open(file, cwd, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		const branch = reopened.getBranchView();
		if (branch.length < INCIDENT_FIXTURE_ENTRIES + 8)
			throw new Error("reopened incident session lost the synthetic workload");
		const terminal = branch.at(-1);
		if (
			terminal?.type !== "message" ||
			terminal.message.role !== "assistant" ||
			!terminal.message.content.some(block => block.type === "text" && block.text.includes(FINAL_SENTINEL))
		) {
			throw new Error("reopened incident session lost its terminal sentinel");
		}
	} finally {
		await reopened.close();
		reopened.releaseRetainedEntries();
	}
}

async function waitForNativeBoundary(state: AttributionState, stage: string): Promise<void> {
	if (!state.mode || !state.terminal) return;
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const native = state.mode.ui.getNativeProbeMetrics();
		const terminal = state.terminal.getProbeMetrics();
		if (
			native.framesSent > 0 &&
			native.framesAcknowledged >= native.framesSent &&
			native.unackedFrames === 0 &&
			native.pendingBlobBytes === 0 &&
			terminal.pendingOutputBytes === 0
		) {
			return;
		}
		await Bun.sleep(1);
	}
	throw new Error(`${stage} did not drain native frames at the turn boundary`);
}

async function stopAtSafeBoundary(state: AttributionState): Promise<boolean> {
	const stopFile = process.env.OMP_MEMORY_PROBE_STOP_FILE;
	if (!stopFile || !(await Bun.file(stopFile).exists())) return false;
	await state.emit("incident:cooperative-stop");
	return true;
}

async function emitPostWorkloadDiagnostics(state: AttributionState): Promise<void> {
	const stats = heapStats();
	await state.emit("incident:post-heap-stats", "heapStats", {
		heapSize: stats.heapSize,
		extraMemorySize: stats.extraMemorySize,
		objectCount: stats.objectCount,
		protectedObjectCount: stats.protectedObjectCount,
	});
	Bun.gc(true);
	await state.emit("incident:post-gc", "gc");
}

function createReplacementTool(state: AttributionState): CustomTool<typeof incidentReplacementParameters> {
	return {
		name: "incident_replacement",
		label: "Incident replacement probe",
		description: "Emits bounded synthetic replacement results for the memory attribution workload.",
		loadMode: "essential",
		parameters: incidentReplacementParameters,
		async execute(toolCallId, params, onUpdate) {
			if (params.turn !== 2 || !onUpdate) throw new Error("incident replacement probe received an invalid turn");
			const sidecarA = path.join(state.workspace, "replacement-sidecar-a.txt");
			const sidecarB = path.join(state.workspace, "replacement-sidecar-b.txt");
			const sidecarAText = sizedText("replacement sidecar A\n", 64 * 1024, 301);
			const sidecarBText = sizedText("replacement sidecar B\n", 64 * 1024, 302);
			await fs.writeFile(sidecarA, sidecarAText);
			await fs.writeFile(sidecarB, sidecarBText);
			state.expectedWriteHashes.set(sidecarA, hashText(sidecarAText));
			state.expectedWriteHashes.set(sidecarB, hashText(sidecarBText));
			for (let replacement = 1; replacement <= PROBE_REPLACEMENT_COUNT; replacement++) {
				const text = sizedText(`replacement ${replacement}\n`, PROBE_RESULT_TEXT_BYTES, replacement);
				const detailPayload = sizedText(`nested details ${replacement}\n`, PROBE_DETAILS_BYTES, replacement + 100);
				onUpdate({
					content: [
						{ type: "text", text },
						{ type: "image", data: INCIDENT_FIXTURE_PNG_BASE64, mimeType: "image/png" },
					],
					details: {
						replacement,
						nested: {
							payload: detailPayload,
							images: [{ type: "image", data: INCIDENT_FIXTURE_PNG_BASE64, mimeType: "image/png" }],
						},
						xdev: {
							inner: { images: [{ type: "image", data: INCIDENT_FIXTURE_PNG_BASE64, mimeType: "image/png" }] },
						},
					},
				});
				await Bun.sleep(0);
				state.captureToolComponent(toolCallId);
				state.replacementResultsObserved++;
				await state.emit(`incident:result-replacement:${replacement}`);
			}
			return {
				content: [{ type: "text", text: "incident replacement final result" }],
				details: { replacement: "final" },
			};
		},
	};
}

async function run(): Promise<void> {
	const options = parseOptions();
	const fixture = await verifyIncidentMemoryFixture(options.fixtureFile, options.fixtureChecksum);
	if (
		fixture.sourceBytes !== INCIDENT_FIXTURE_BYTES ||
		fixture.entryCount !== INCIDENT_FIXTURE_ENTRIES ||
		fixture.linkedTailId !== INCIDENT_FIXTURE_LINKED_TAIL_ID
	) {
		throw new Error("prepared fixture did not meet the incident-scale contract");
	}
	if (!nativeAddonStatus()) throw new Error("incident attribution probe did not load the compiled native addon");
	const metrics = await MetricsWriter.create();
	const stopEventProbe = beginEventStreamProbe(streamedEventBytes);
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-incident-memory-attribution-"));
	const state = new AttributionState(options, fixture, metrics);
	const stopRequestPreparationProbe = beginOpenAIRequestPreparationProbe(
		(phase, inputItemCount, toolCount, serializedCodeUnits) => {
			state.recordRequestPreparation(phase, inputItemCount, toolCount, serializedCodeUnits);
		},
	);
	state.workspace = workspace;
	let server: Bun.Server<undefined> | undefined;
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let authStorage: AuthStorage | undefined;
	let removeProviderContextProbe: (() => void) | undefined;
	let providerContextObserved = false;
	try {
		const loopback = new LoopbackResponses(workspace, state.expectedWriteHashes);
		state.loopback = loopback;
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => loopback.fetch(request) });
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
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai", "incident-loopback-key");
		const model = localResponsesModel(server.url.toString().replace(/\/$/, ""));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workspace, "models.yml"), { settings });
		const manager = await SessionManager.open(options.fixtureFile, workspace, undefined, {
			initialCwd: workspace,
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		state.manager = manager;
		const rules = [createSyntheticRule(workspace)];
		const contextFiles = [
			{
				path: path.join(workspace, "INCIDENT_CONTEXT.md"),
				content: "Synthetic incident attribution context. Loopback only. No external services.",
			},
		];
		const created = await createAgentSession({
			cwd: workspace,
			agentDir: path.join(workspace, "agent"),
			sessionManager: manager,
			settings,
			authStorage,
			modelRegistry,
			model,
			getApiKey: () => "incident-loopback-key",
			customTools: [createReplacementTool(state)],
			toolNames: ["write", "incident_replacement"],
			autoApprove: true,
			disableExtensionDiscovery: true,
			skills: [],
			rules,
			contextFiles,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			cacheWarming: false,
			workspaceTree: { rootPath: workspace, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			bindProcessState: false,
		});
		session = created.session;
		removeProviderContextProbe = session.agent.addBeforeModelCall(async context => {
			if (providerContextObserved) return;
			providerContextObserved = true;
			await state.emit("incident:provider-context-prepared", "passive", undefined, {
				phase: "agent-provider-context-prepared",
				inputItemCount: context.messages.length,
				toolCount: context.tools?.length ?? 0,
				serializedCodeUnits: 0,
			});
		});
		state.restoredEntries = manager.getBranchView().length;
		state.agentMessageCount = session.agent.state.messages.length;
		state.builtinToolCount = session.getAllToolNames().length;
		state.enabledToolCount = session.getEnabledToolNames().length;
		state.ruleCount = rules.length;
		state.contextFileCount = contextFiles.length;
		state.promptBytes = session.agent.state.systemPrompt.reduce(
			(total, part) => total + Buffer.byteLength(part, "utf8"),
			0,
		);
		assertRestoredFixture(session.agent.state.messages, fixture);
		unsubscribe = session.subscribe(event => {
			state.observe(event);
			if (event.type === "tool_execution_start" && event.toolCallId === "incident-streamed-write") {
				state.schedule("incident:streamed-call-complete");
			}
		});
		await state.emit("incident:sdk-restore");
		if (await stopAtSafeBoundary(state)) {
			await emitPostWorkloadDiagnostics(state);
			return;
		}

		if (options.arm === "native") {
			await initTheme();
			const terminal = new ProcessTerminal();
			const composer = new Composer({ terminal, preferences: { quiet: true } });
			const mode = new InteractiveMode(
				session,
				"incident-memory-attribution",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				composer,
			);
			state.mode = mode;
			state.terminal = terminal;
			state.modeConstructs = 1;
			const originalModeStop = mode.stop.bind(mode);
			mode.stop = () => {
				state.modeStops++;
				originalModeStop();
			};
			const originalTuiStop = mode.ui.stop.bind(mode.ui);
			mode.ui.stop = () => {
				state.tuiStops++;
				originalTuiStop();
			};
			await mode.init({ suppressWelcomeIntro: true });
			await mode.renderInitialMessages({ clearTerminalHistory: true });
			await waitForNativeBoundary(state, "incident:history-replay");
			if (!mode.ui.nativeRendering) throw new Error("incident attribution probe did not activate native rendering");
			if (!terminal.getProbeMetrics().ttyWriterConstructed) {
				throw new Error("incident attribution probe did not construct the native TtyWriter");
			}
		}
		await state.emit("incident:request-preparation");
		if (await stopAtSafeBoundary(state)) {
			await emitPostWorkloadDiagnostics(state);
			return;
		}
		await session.prompt("Run the synthetic incident attribution workload through the active tools.");
		await session.waitForIdle();
		if (state.observerError) throw state.observerError;
		if (loopback.requestCount !== 4 || loopback.requestHashes.length !== 4) {
			throw new Error(`loopback serialized ${loopback.requestCount} turns, expected four`);
		}
		if (state.replacementResultsObserved !== PROBE_REPLACEMENT_COUNT) {
			throw new Error(
				`replacement tool emitted ${state.replacementResultsObserved} results, expected ${PROBE_REPLACEMENT_COUNT}`,
			);
		}
		if (state.cumulativeArgumentBytes < LIVE_WRITE_HTML_BYTES) {
			throw new Error("provider argument accumulation never reached the streamed live write payload");
		}
		await waitForNativeBoundary(state, "incident:turn-boundary");
		if (await stopAtSafeBoundary(state)) {
			await emitPostWorkloadDiagnostics(state);
			return;
		}
		await verifyWrites(state);
		await manager.flush();
		await verifyPersistence(options.fixtureFile, workspace);
		state.finalResultCount = 4;
		await state.emit("incident:complete");
		await emitPostWorkloadDiagnostics(state);
		unsubscribe();
		unsubscribe = undefined;
	} finally {
		removeProviderContextProbe?.();
		stopRequestPreparationProbe();
		unsubscribe?.();
		if (state.mode) state.mode.stop();
		if (session) {
			await session.dispose();
		} else if (state.manager) {
			await state.manager.close();
			state.manager.releaseRetainedEntries();
		}
		authStorage?.close();
		server?.stop(true);
		stopEventProbe();
		await metrics.close();
		await fs.rm(workspace, { recursive: true, force: true });
	}
}

void run().catch(error => {
	process.stderr.write(
		`incident memory attribution probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
