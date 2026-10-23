#!/usr/bin/env bun

/**
 * Scalar-only projector for the confirmed killed-session prefix. It streams one
 * physical line at a time and emits only schema enums, numeric measurements,
 * ordinal topology, and structural shapes. It never writes source IDs, text,
 * URLs, commands, opaque replay data, images, or arbitrary object keys.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

const EXPECTED_PREFIX_BYTES = 149_212_043;
const EXPECTED_CUTOFF = "2026-10-23T03:25:20Z";
const DESCRIPTOR_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_PHYSICAL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_SHAPE_DEPTH = 12;
const MAX_SHAPE_NODES = 512;
const MAX_SHAPE_CONTAINER_ITEMS = 128;
const MAX_INCOMPLETE_REASONS = 64;

const ENTRY_TYPE: Record<string, true> = {
	message: true,
	model_usage: true,
	thinking_level_change: true,
	model_change: true,
	service_tier_change: true,
	compaction: true,
	branch_summary: true,
	custom: true,
	custom_message: true,
	label: true,
	title_change: true,
	ttsr_injection: true,
	session_init: true,
	mode_change: true,
	credential_pin: true,
	reset_boundary: true,
};
const MESSAGE_ROLE: Record<string, true> = { user: true, developer: true, assistant: true, toolResult: true };
const STOP_REASON: Record<string, true> = { stop: true, length: true, toolUse: true, error: true, aborted: true };
const COMPACTION_METHOD: Record<string, true> = { remote: true, snapcompact: true, handoff: true, soft: true, shake: true };
const PRESERVE_KEY: Record<string, true> = { openaiRemoteCompaction: true, anthropicCompaction: true, snapcompact: true };

type EntryType = keyof typeof ENTRY_TYPE;
type MessageRole = keyof typeof MESSAGE_ROLE;
type StopReason = keyof typeof STOP_REASON;
type CompactionMethod = keyof typeof COMPACTION_METHOD;
type IncompleteReason =
	| "descriptor-output-limit"
	| "line-byte-limit"
	| "truncated-prefix-line"
	| "malformed-json"
	| "invalid-session-entry"
	| "invalid-entry-id"
	| "unknown-entry-type"
	| "duplicate-entry-id"
	| "post-cutoff-interrupts-prefix"
	| "missing-parent"
	| "parent-cycle"
	| "missing-selected-leaf"
	| "unresolved-compaction-boundary"
	| "unsupported-message-role"
	| "unsupported-message-block"
	| "unsupported-context-message-field"
	| "unsupported-message-provider-payload"
	| "unsupported-compaction-preserve-data"
	| "unsupported-provider-replay"
	| "unsupported-snapcompact-archive"
	| "unsupported-rollover-details"
	| "unsupported-context-notes"
	| "shape-depth-limit"
	| "shape-node-limit"
	| "shape-container-limit"
	| "output-limit";

type JsonRecord = Record<string, unknown>;
type NumericScalar = { present: boolean; value: number | null };
type ScalarShape =
	| { kind: "null" | "boolean" | "number" }
	| { kind: "string"; utf8Bytes: number; utf16Units: number }
	| { kind: "array"; length: number; values: ScalarShape[] }
	| { kind: "object"; propertyCount: number; values: ScalarShape[] };

type UsageScalar = {
	present: boolean;
	input: NumericScalar;
	output: NumericScalar;
	cacheRead: NumericScalar;
	cacheWrite: NumericScalar;
	totalTokens: NumericScalar;
	contextTokens: NumericScalar;
	orchestrationInput: NumericScalar;
	orchestrationOutput: NumericScalar;
	orchestrationCacheRead: NumericScalar;
	anchorEligible: boolean;
};

type ContextSnapshotScalar = {
	present: boolean;
	promptTokens: NumericScalar;
	nonMessageTokens: NumericScalar;
	toolSchemaTokens: NumericScalar;
	historyRewriteTokensRemoved: NumericScalar;
	compactionEpoch: NumericScalar;
	lastMessageOffsetMs: NumericScalar;
};

type ArchiveScalar = {
	frameCount: number;
	frames: { dataUtf8Bytes: number; cols: NumericScalar; rows: NumericScalar; chars: NumericScalar }[];
	textUtf8Bytes: number;
	textHeadUtf8Bytes: number;
	textTailUtf8Bytes: number;
	totalChars: NumericScalar;
	truncatedChars: NumericScalar;
	withoutThinking: { present: boolean; summaryUtf8Bytes: number; archive: ArchiveScalar | null };
};

type PreserveDataScalar = {
	present: boolean;
	recognizedKeys: (keyof typeof PRESERVE_KEY)[];
	unrecognizedKeyCount: number;
	openAiRemote?: {
		version: "v1" | "v2" | "unknown";
		replacementHistoryCount: number;
		replacementShapes: ScalarShape[];
		compactionItem: { kind: "compaction" | "compaction_summary" | "absent" | "unknown"; payloadUtf8Bytes: number };
		usedTokens: NumericScalar;
	};
	anthropic?: {
		contentUtf8Bytes: number;
		signatureUtf8Bytes: number;
		encryptedContentUtf8Bytes: number;
		filesTextUtf8Bytes: number;
		retainedFiles: { textUtf8Bytes: number; afterOffsetMs: NumericScalar }[];
		toolChangeShapes: ScalarShape[];
		exactTail: boolean;
		usedTokens: NumericScalar;
	};
	snapcompact?: ArchiveScalar;
};

type CompactionScalar = {
	summaryUtf8Bytes: number;
	summaryUtf16Units: number;
	shortSummaryUtf8Bytes: number;
	tokensBefore: NumericScalar;
	tokensAfter: NumericScalar;
	method: CompactionMethod | "absent" | "unknown";
	firstKeptOrdinal: number | null;
	firstKeptState: "empty" | "ordinal" | "missing";
	providerReplayThroughOrdinal: number | null;
	providerReplayThroughState: "absent" | "ordinal" | "missing";
	rollover: boolean;
	preserve: PreserveDataScalar;
};

type EntryDescriptor = {
	ordinal: number;
	parent: { state: "root" | "ordinal" | "missing"; ordinal: number | null };
	activeLeaf: { state: "absent" | "null" | "ordinal" | "dangling"; ordinal: number | null };
	type: EntryType;
	entryTimestampOffsetMs: number;
	physicalBytes: number;
	role?: MessageRole | "unknown";
	messageTimestampOffsetMs?: number;
	stopReason?: StopReason | "unknown";
	usage?: UsageScalar;
	contextSnapshot?: ContextSnapshotScalar;
	retryRecovery?: boolean;
	emptyErrorTurn?: boolean;
	content?: {
		kind: "string" | "blocks";
		utf8Bytes: number;
		utf16Units: number;
		blockCounts: Record<"text" | "thinking" | "redactedThinking" | "image" | "toolCall" | "fallback", number>;
		imageDataUtf8Bytes: number;
		toolCallCount: number;
	};
	argumentShapes?: ScalarShape[];
	detailsShape?: ScalarShape;
	toolResultPairOrdinal?: number | null;
	customType?: "context-notes" | "prewalk-plan" | "vibe" | "irc-incoming-parent" | "other";
	branchSummaryUtf8Bytes?: number;
	retainedOpaqueLineBytes?: number;
	rewriteRelations?: { prunedAtOffsetMs: NumericScalar; historyRewriteAtOffsetMs: NumericScalar };
	compaction?: CompactionScalar;
};

type InternalDescriptor = {
	sourceId: string;
	parentSourceId: string | null;
	activeLeafSourceId: string | null | undefined;
	entryTimestampMs: number;
	messageTimestampMs: number | undefined;
	toolCallIds: string[];
	toolResultCallId: string | undefined;
	firstKeptSourceId: string | undefined;
	providerReplayThroughSourceId: string | undefined;
	isContextNotes: boolean;
	isRolloverRequest: boolean;
	entry: EntryDescriptor;
};

type BaseEntry = {
	type: EntryType;
	sourceId: string;
	parentSourceId: string | null;
	activeLeafSourceId: string | null | undefined;
	entryTimestampMs: number;
};

type PayloadTotals = {
	contentTextUtf8Bytes: number;
	thinkingUtf8Bytes: number;
	redactedThinkingUtf8Bytes: number;
	imageDataUtf8Bytes: number;
	argumentStringUtf8Bytes: number;
	detailsStringUtf8Bytes: number;
	compactionSummaryUtf8Bytes: number;
	providerReplayStringUtf8Bytes: number;
	archiveStringUtf8Bytes: number;
	opaqueStoredLineBytes: number;
};

type Counters = {
	physicalRows: number;
	validSessionEntries: number;
	malformedRows: number;
	postCutoffRows: number;
	selectedRows: number;
	selectedBoundaryBytes: number;
	largestPhysicalLineBytes: number;
	truncatedTrailingBytes: number;
	postCutoffInterruptsSelectedPrefix: boolean;
};

function requiredValue(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
	return value;
}

function requiredInteger(flag: string): number {
	const value = Number(requiredValue(flag));
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a nonnegative integer`);
	return value;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function textMetrics(value: unknown): { utf8Bytes: number; utf16Units: number } {
	const text = typeof value === "string" ? value : "";
	return { utf8Bytes: utf8Bytes(text), utf16Units: text.length };
}

function numericField(record: JsonRecord | undefined, key: string): NumericScalar {
	const present = record !== undefined && Object.hasOwn(record, key);
	const value = record?.[key];
	return { present, value: typeof value === "number" && Number.isFinite(value) ? value : null };
}

function addReason(reasons: Set<IncompleteReason>, reason: IncompleteReason): void {
	if (reasons.size < MAX_INCOMPLETE_REASONS) reasons.add(reason);
}

function addPayload(totals: PayloadTotals, field: keyof PayloadTotals, bytes: number): void {
	if (bytes > 0) totals[field] += bytes;
}

function emptyPayloadTotals(): PayloadTotals {
	return {
		contentTextUtf8Bytes: 0,
		thinkingUtf8Bytes: 0,
		redactedThinkingUtf8Bytes: 0,
		imageDataUtf8Bytes: 0,
		argumentStringUtf8Bytes: 0,
		detailsStringUtf8Bytes: 0,
		compactionSummaryUtf8Bytes: 0,
		providerReplayStringUtf8Bytes: 0,
		archiveStringUtf8Bytes: 0,
		opaqueStoredLineBytes: 0,
	};
}

function scalarShape(
	value: unknown,
	reasons: Set<IncompleteReason>,
	totals: PayloadTotals,
	payloadField: "argumentStringUtf8Bytes" | "detailsStringUtf8Bytes" | "providerReplayStringUtf8Bytes",
	depth = 0,
	budget: { nodes: number } = { nodes: 0 },
): ScalarShape | undefined {
	if (depth > MAX_SHAPE_DEPTH) {
		addReason(reasons, "shape-depth-limit");
		return undefined;
	}
	budget.nodes++;
	if (budget.nodes > MAX_SHAPE_NODES) {
		addReason(reasons, "shape-node-limit");
		return undefined;
	}
	if (value === null) return { kind: "null" };
	if (typeof value === "boolean") return { kind: "boolean" };
	if (typeof value === "number" && Number.isFinite(value)) return { kind: "number" };
	if (typeof value === "string") {
		const metrics = textMetrics(value);
		addPayload(totals, payloadField, metrics.utf8Bytes);
		return { kind: "string", ...metrics };
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_SHAPE_CONTAINER_ITEMS) {
			addReason(reasons, "shape-container-limit");
			return undefined;
		}
		const values: ScalarShape[] = [];
		for (const item of value) {
			const shape = scalarShape(item, reasons, totals, payloadField, depth + 1, budget);
			if (!shape) return undefined;
			values.push(shape);
		}
		return { kind: "array", length: value.length, values };
	}
	if (isRecord(value)) {
		const values = Object.values(value);
		if (values.length > MAX_SHAPE_CONTAINER_ITEMS) {
			addReason(reasons, "shape-container-limit");
			return undefined;
		}
		const shapes: ScalarShape[] = [];
		for (const item of values) {
			const shape = scalarShape(item, reasons, totals, payloadField, depth + 1, budget);
			if (!shape) return undefined;
			shapes.push(shape);
		}
		return { kind: "object", propertyCount: values.length, values: shapes };
	}
	addReason(reasons, "shape-node-limit");
	return undefined;
}

function usageScalar(value: unknown): UsageScalar {
	const usage = isRecord(value) ? value : undefined;
	const input = numericField(usage, "input");
	const output = numericField(usage, "output");
	const cacheRead = numericField(usage, "cacheRead");
	const cacheWrite = numericField(usage, "cacheWrite");
	const totalTokens = numericField(usage, "totalTokens");
	const contextTokens = numericField(usage, "contextTokens");
	const orchestration = usage && isRecord(usage.orchestration) ? usage.orchestration : undefined;
	const orchestrationInput = numericField(orchestration, "input");
	const orchestrationOutput = numericField(orchestration, "output");
	const orchestrationCacheRead = numericField(orchestration, "cacheRead");
	const prompt = (input.value ?? 0) + (cacheRead.value ?? 0) + (cacheWrite.value ?? 0);
	const rawTotal = totalTokens.value || prompt + (output.value ?? 0);
	const context = Math.max(0, rawTotal - (orchestrationInput.value ?? 0) - (orchestrationOutput.value ?? 0) - (orchestrationCacheRead.value ?? 0));
	return {
		present: usage !== undefined,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		contextTokens,
		orchestrationInput,
		orchestrationOutput,
		orchestrationCacheRead,
		anchorEligible: (contextTokens.value ?? 0) > 0 || prompt > 0 || context > (output.value ?? 0),
	};
}

function contextSnapshotScalar(value: unknown): ContextSnapshotScalar {
	const snapshot = isRecord(value) ? value : undefined;
	return {
		present: snapshot !== undefined,
		promptTokens: numericField(snapshot, "promptTokens"),
		nonMessageTokens: numericField(snapshot, "nonMessageTokens"),
		toolSchemaTokens: numericField(snapshot, "toolSchemaTokens"),
		historyRewriteTokensRemoved: numericField(snapshot, "historyRewriteTokensRemoved"),
		compactionEpoch: numericField(snapshot, "compactionEpoch"),
		lastMessageOffsetMs: numericField(snapshot, "lastMessageTimestamp"),
	};
}

type BlockCounts = Record<"text" | "thinking" | "redactedThinking" | "image" | "toolCall" | "fallback", number>;

function emptyBlockCounts(): BlockCounts {
	return { text: 0, thinking: 0, redactedThinking: 0, image: 0, toolCall: 0, fallback: 0 };
}

function contentScalar(
	value: unknown,
	role: MessageRole,
	reasons: Set<IncompleteReason>,
	totals: PayloadTotals,
	toolCallIds: string[],
	argumentShapes: ScalarShape[],
): { content: NonNullable<EntryDescriptor["content"]>; meaningfulErrorOutput: boolean } | undefined {
	if (typeof value === "string") {
		if (role === "assistant" || role === "toolResult") {
			addReason(reasons, "unsupported-context-message-field");
			return undefined;
		}
		const metrics = textMetrics(value);
		addPayload(totals, "contentTextUtf8Bytes", metrics.utf8Bytes);
		return {
			content: { kind: "string", ...metrics, blockCounts: emptyBlockCounts(), imageDataUtf8Bytes: 0, toolCallCount: 0 },
			meaningfulErrorOutput: value.trim().length > 0,
		};
	}
	if (!Array.isArray(value)) {
		addReason(reasons, "unsupported-context-message-field");
		return undefined;
	}
	const counts = emptyBlockCounts();
	let textBytes = 0;
	let textUnits = 0;
	let imageBytes = 0;
	let meaningfulErrorOutput = false;
	for (const block of value) {
		if (!isRecord(block) || typeof block.type !== "string") {
			addReason(reasons, "unsupported-message-block");
			return undefined;
		}
		if (role !== "assistant" && block.type !== "text" && block.type !== "image") {
			addReason(reasons, "unsupported-message-block");
			return undefined;
		}
		switch (block.type) {
			case "text": {
				if (typeof block.text !== "string") {
					addReason(reasons, "unsupported-message-block");
					return undefined;
				}
				const metrics = textMetrics(block.text);
				counts.text++;
				textBytes += metrics.utf8Bytes;
				textUnits += metrics.utf16Units;
				addPayload(totals, "contentTextUtf8Bytes", metrics.utf8Bytes);
				meaningfulErrorOutput ||= block.text.trim().length > 0;
				break;
			}
			case "thinking": {
				if (typeof block.thinking !== "string") {
					addReason(reasons, "unsupported-message-block");
					return undefined;
				}
				const metrics = textMetrics(block.thinking);
				counts.thinking++;
				textBytes += metrics.utf8Bytes;
				textUnits += metrics.utf16Units;
				addPayload(totals, "thinkingUtf8Bytes", metrics.utf8Bytes);
				meaningfulErrorOutput ||= block.thinking.trim().length > 0 || (typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0);
				break;
			}
			case "redactedThinking": {
				if (typeof block.data !== "string") {
					addReason(reasons, "unsupported-message-block");
					return undefined;
				}
				const metrics = textMetrics(block.data);
				counts.redactedThinking++;
				textBytes += metrics.utf8Bytes;
				textUnits += metrics.utf16Units;
				addPayload(totals, "redactedThinkingUtf8Bytes", metrics.utf8Bytes);
				meaningfulErrorOutput ||= block.data.trim().length > 0;
				break;
			}
			case "image": {
				if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
					addReason(reasons, "unsupported-message-block");
					return undefined;
				}
				counts.image++;
				const bytes = utf8Bytes(block.data);
				imageBytes += bytes;
				addPayload(totals, "imageDataUtf8Bytes", bytes);
				meaningfulErrorOutput = true;
				break;
			}
			case "toolCall": {
				if (typeof block.id !== "string" || !isRecord(block.arguments)) {
					addReason(reasons, "unsupported-message-block");
					return undefined;
				}
				const shape = scalarShape(block.arguments, reasons, totals, "argumentStringUtf8Bytes");
				if (!shape) return undefined;
				counts.toolCall++;
				toolCallIds.push(block.id);
				argumentShapes.push(shape);
				meaningfulErrorOutput = true;
				break;
			}
			case "fallback":
				counts.fallback++;
				break;
			default:
				addReason(reasons, "unsupported-message-block");
				return undefined;
		}
	}
	return {
		content: { kind: "blocks", utf8Bytes: textBytes, utf16Units: textUnits, blockCounts: counts, imageDataUtf8Bytes: imageBytes, toolCallCount: toolCallIds.length },
		meaningfulErrorOutput,
	};
}

function archiveScalar(value: unknown, reasons: Set<IncompleteReason>, totals: PayloadTotals, includeVariant = true): ArchiveScalar | undefined {
	if (!isRecord(value) || !Array.isArray(value.frames)) {
		addReason(reasons, "unsupported-snapcompact-archive");
		return undefined;
	}
	const allowed = { frames: true, totalChars: true, truncatedChars: true, text: true, textHead: true, textTail: true, withoutThinking: true };
	if (Object.keys(value).some(key => !Object.hasOwn(allowed, key))) {
		addReason(reasons, "unsupported-snapcompact-archive");
		return undefined;
	}
	const frames: ArchiveScalar["frames"] = [];
	for (const frame of value.frames) {
		if (!isRecord(frame) || typeof frame.data !== "string" || typeof frame.mimeType !== "string") {
			addReason(reasons, "unsupported-snapcompact-archive");
			return undefined;
		}
		frames.push({ dataUtf8Bytes: utf8Bytes(frame.data), cols: numericField(frame, "cols"), rows: numericField(frame, "rows"), chars: numericField(frame, "chars") });
	}
	const textBytes = utf8Bytes(typeof value.text === "string" ? value.text : "");
	const textHeadBytes = utf8Bytes(typeof value.textHead === "string" ? value.textHead : "");
	const textTailBytes = utf8Bytes(typeof value.textTail === "string" ? value.textTail : "");
	addPayload(totals, "archiveStringUtf8Bytes", frames.reduce((total, frame) => total + frame.dataUtf8Bytes, 0) + textBytes + textHeadBytes + textTailBytes);
	let withoutThinking: ArchiveScalar["withoutThinking"] = { present: false, summaryUtf8Bytes: 0, archive: null };
	if (includeVariant && value.withoutThinking !== undefined) {
		if (!isRecord(value.withoutThinking) || typeof value.withoutThinking.summary !== "string") {
			addReason(reasons, "unsupported-snapcompact-archive");
			return undefined;
		}
		const nested = archiveScalar(value.withoutThinking.archive, reasons, totals, false);
		if (!nested) return undefined;
		withoutThinking = { present: true, summaryUtf8Bytes: utf8Bytes(value.withoutThinking.summary), archive: nested };
	}
	return {
		frameCount: frames.length,
		frames,
		textUtf8Bytes: textBytes,
		textHeadUtf8Bytes: textHeadBytes,
		textTailUtf8Bytes: textTailBytes,
		totalChars: numericField(value, "totalChars"),
		truncatedChars: numericField(value, "truncatedChars"),
		withoutThinking,
	};
}

function preserveDataScalar(value: unknown, reasons: Set<IncompleteReason>, totals: PayloadTotals): PreserveDataScalar {
	if (value === undefined) return { present: false, recognizedKeys: [], unrecognizedKeyCount: 0 };
	if (!isRecord(value)) {
		addReason(reasons, "unsupported-compaction-preserve-data");
		return { present: true, recognizedKeys: [], unrecognizedKeyCount: 1 };
	}
	const recognizedKeys = Object.keys(value).filter((key): key is keyof typeof PRESERVE_KEY => Object.hasOwn(PRESERVE_KEY, key));
	const unrecognizedKeyCount = Object.keys(value).length - recognizedKeys.length;
	if (unrecognizedKeyCount > 0) addReason(reasons, "unsupported-compaction-preserve-data");
	const result: PreserveDataScalar = { present: true, recognizedKeys, unrecognizedKeyCount };
	const remote = value.openaiRemoteCompaction;
	if (remote !== undefined) {
		if (!isRecord(remote) || !Array.isArray(remote.replacementHistory)) {
			addReason(reasons, "unsupported-provider-replay");
		} else {
			const replacementShapes: ScalarShape[] = [];
			for (const item of remote.replacementHistory) {
				if (!isRecord(item)) {
					addReason(reasons, "unsupported-provider-replay");
					break;
				}
				const shape = scalarShape(item, reasons, totals, "providerReplayStringUtf8Bytes");
				if (!shape) break;
				replacementShapes.push(shape);
			}
			const v2 = remote.version === "v2";
			const item = isRecord(remote.compactionItem) ? remote.compactionItem : undefined;
			const kind = item?.type === "compaction" || item?.type === "compaction_summary" ? item.type : item === undefined && v2 ? "absent" : "unknown";
			if (kind === "unknown") addReason(reasons, "unsupported-provider-replay");
			const payload = typeof item?.encrypted_content === "string" ? item.encrypted_content : typeof item?.summary === "string" ? item.summary : "";
			const payloadBytes = utf8Bytes(payload);
			addPayload(totals, "providerReplayStringUtf8Bytes", payloadBytes);
			result.openAiRemote = {
				version: v2 ? "v2" : item ? "v1" : "unknown",
				replacementHistoryCount: remote.replacementHistory.length,
				replacementShapes,
				compactionItem: { kind, payloadUtf8Bytes: payloadBytes },
				usedTokens: numericField(remote, "usedTokens"),
			};
		}
	}
	const anthropic = value.anthropicCompaction;
	if (anthropic !== undefined) {
		if (!isRecord(anthropic) || typeof anthropic.content !== "string") {
			addReason(reasons, "unsupported-provider-replay");
		} else {
			const allowed = { provider: true, content: true, toolChanges: true, signature: true, encryptedContent: true, filesText: true, retainedFiles: true, exactTail: true, model: true, usedTokens: true };
			if (Object.keys(anthropic).some(key => !Object.hasOwn(allowed, key))) addReason(reasons, "unsupported-provider-replay");
			const toolChangeShapes: ScalarShape[] = [];
			if (anthropic.toolChanges !== undefined) {
				if (!Array.isArray(anthropic.toolChanges)) addReason(reasons, "unsupported-provider-replay");
				else for (const change of anthropic.toolChanges) {
					const shape = scalarShape(change, reasons, totals, "providerReplayStringUtf8Bytes");
					if (!shape) break;
					toolChangeShapes.push(shape);
				}
			}
			const retainedFiles: { textUtf8Bytes: number; afterOffsetMs: NumericScalar }[] = [];
			if (anthropic.retainedFiles !== undefined) {
				if (!Array.isArray(anthropic.retainedFiles)) addReason(reasons, "unsupported-provider-replay");
				else for (const file of anthropic.retainedFiles) {
					if (!isRecord(file) || typeof file.text !== "string") {
						addReason(reasons, "unsupported-provider-replay");
						break;
					}
					retainedFiles.push({ textUtf8Bytes: utf8Bytes(file.text), afterOffsetMs: numericField(file, "after") });
				}
			}
			const contentUtf8Bytes = utf8Bytes(anthropic.content);
			const signatureUtf8Bytes = utf8Bytes(typeof anthropic.signature === "string" ? anthropic.signature : "");
			const encryptedContentUtf8Bytes = utf8Bytes(typeof anthropic.encryptedContent === "string" ? anthropic.encryptedContent : "");
			const filesTextUtf8Bytes = utf8Bytes(typeof anthropic.filesText === "string" ? anthropic.filesText : "");
			addPayload(totals, "providerReplayStringUtf8Bytes", contentUtf8Bytes + signatureUtf8Bytes + encryptedContentUtf8Bytes + filesTextUtf8Bytes + retainedFiles.reduce((total, file) => total + file.textUtf8Bytes, 0));
			result.anthropic = { contentUtf8Bytes, signatureUtf8Bytes, encryptedContentUtf8Bytes, filesTextUtf8Bytes, retainedFiles, toolChangeShapes, exactTail: anthropic.exactTail === true, usedTokens: numericField(anthropic, "usedTokens") };
		}
	}
	if (value.snapcompact !== undefined) {
		const archive = archiveScalar(value.snapcompact, reasons, totals);
		if (archive) result.snapcompact = archive;
	}
	return result;
}

function customTypeCategory(value: unknown): EntryDescriptor["customType"] {
	if (value === "experimental_context_notes") return "context-notes";
	if (value === "prewalk-plan") return "prewalk-plan";
	if (value === "vibe-mode-context") return "vibe";
	if (value === "irc:incoming") return "irc-incoming-parent";
	return "other";
}

function baseEntry(record: JsonRecord): BaseEntry | undefined {
	if (typeof record.type !== "string" || !Object.hasOwn(ENTRY_TYPE, record.type)) return undefined;
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 512) return undefined;
	if (record.parentId !== null && typeof record.parentId !== "string") return undefined;
	if (typeof record.timestamp !== "string") return undefined;
	const entryTimestampMs = Date.parse(record.timestamp);
	if (!Number.isFinite(entryTimestampMs)) return undefined;
	if (record.activeLeafId !== undefined && record.activeLeafId !== null && typeof record.activeLeafId !== "string") return undefined;
	return {
		type: record.type as EntryType,
		sourceId: record.id,
		parentSourceId: record.parentId,
		activeLeafSourceId: record.activeLeafId as string | null | undefined,
		entryTimestampMs,
	};
}

function makeDescriptor(
	record: JsonRecord,
	base: BaseEntry,
	ordinal: number,
	physicalBytes: number,
	reasons: Set<IncompleteReason>,
	totals: PayloadTotals,
): InternalDescriptor | undefined {
	const entry: EntryDescriptor = {
		ordinal,
		parent: { state: base.parentSourceId === null ? "root" : "missing", ordinal: null },
		activeLeaf: { state: base.activeLeafSourceId === undefined ? "absent" : base.activeLeafSourceId === null ? "null" : "dangling", ordinal: null },
		type: base.type,
		entryTimestampOffsetMs: base.entryTimestampMs,
		physicalBytes,
	};
	let messageTimestampMs: number | undefined;
	let toolResultCallId: string | undefined;
	const toolCallIds: string[] = [];
	const argumentShapes: ScalarShape[] = [];
	let firstKeptSourceId: string | undefined;
	let providerReplayThroughSourceId: string | undefined;
	let isContextNotes = false;
	let isRolloverRequest = false;

	if (base.type === "message") {
		if (!isRecord(record.message) || typeof record.message.role !== "string" || !Object.hasOwn(MESSAGE_ROLE, record.message.role)) {
			addReason(reasons, "unsupported-message-role");
			return undefined;
		}
		const message = record.message;
		const role = message.role as MessageRole;
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
			addReason(reasons, "unsupported-context-message-field");
			return undefined;
		}
		messageTimestampMs = message.timestamp;
		const content = contentScalar(message.content, role, reasons, totals, toolCallIds, argumentShapes);
		if (!content) return undefined;
		entry.role = role;
		entry.messageTimestampOffsetMs = messageTimestampMs;
		entry.content = content.content;
		entry.argumentShapes = argumentShapes;
		if (role === "assistant") {
			const stopReason = typeof message.stopReason === "string" && Object.hasOwn(STOP_REASON, message.stopReason) ? (message.stopReason as StopReason) : "unknown";
			entry.stopReason = stopReason;
			const usage = usageScalar(message.usage);
			entry.usage = { ...usage, anchorEligible: stopReason !== "aborted" && stopReason !== "error" && usage.anchorEligible };
			entry.contextSnapshot = contextSnapshotScalar(message.contextSnapshot);
			entry.retryRecovery = isRecord(message.retryRecovery);
			entry.emptyErrorTurn = stopReason === "error" && !content.meaningfulErrorOutput;
			if (message.providerPayload !== undefined) addReason(reasons, "unsupported-message-provider-payload");
		}
		if (role === "toolResult") {
			if (typeof message.toolCallId !== "string") {
				addReason(reasons, "unsupported-context-message-field");
				return undefined;
			}
			toolResultCallId = message.toolCallId;
			if (message.details !== undefined) {
				const shape = scalarShape(message.details, reasons, totals, "detailsStringUtf8Bytes");
				if (!shape) return undefined;
				entry.detailsShape = shape;
			}
			entry.rewriteRelations = { prunedAtOffsetMs: numericField(message, "prunedAt"), historyRewriteAtOffsetMs: { present: false, value: null } };
		}
		if (role === "user") {
			entry.rewriteRelations = {
				prunedAtOffsetMs: { present: false, value: null },
				historyRewriteAtOffsetMs: numericField(message, "historyRewriteAt"),
			};
		}
	} else if (base.type === "custom_message") {
		const category = customTypeCategory(record.customType);
		const content = contentScalar(record.content, "user", reasons, totals, toolCallIds, argumentShapes);
		if (!content) return undefined;
		entry.customType = category;
		entry.content = content.content;
		entry.argumentShapes = argumentShapes;
		isRolloverRequest = category === "irc-incoming-parent" && isRecord(record.details) && record.details.fromParent === true;
		if (record.details !== undefined) {
			const shape = scalarShape(record.details, reasons, totals, "detailsStringUtf8Bytes");
			if (!shape) return undefined;
			entry.detailsShape = shape;
		}
	} else if (base.type === "branch_summary") {
		if (typeof record.summary !== "string") {
			addReason(reasons, "invalid-session-entry");
			return undefined;
		}
		entry.branchSummaryUtf8Bytes = utf8Bytes(record.summary);
		addPayload(totals, "contentTextUtf8Bytes", entry.branchSummaryUtf8Bytes);
	} else if (base.type === "compaction") {
		if (typeof record.summary !== "string" || typeof record.firstKeptEntryId !== "string") {
			addReason(reasons, "invalid-session-entry");
			return undefined;
		}
		firstKeptSourceId = record.firstKeptEntryId;
		providerReplayThroughSourceId = typeof record.providerReplayThroughEntryId === "string" ? record.providerReplayThroughEntryId : undefined;
		const method = record.method === undefined ? "absent" : typeof record.method === "string" && Object.hasOwn(COMPACTION_METHOD, record.method) ? (record.method as CompactionMethod) : "unknown";
		if (method === "unknown") addReason(reasons, "invalid-session-entry");
		const summary = textMetrics(record.summary);
		const shortSummaryUtf8Bytes = utf8Bytes(typeof record.shortSummary === "string" ? record.shortSummary : "");
		addPayload(totals, "compactionSummaryUtf8Bytes", summary.utf8Bytes + shortSummaryUtf8Bytes);
		const preserve = preserveDataScalar(record.preserveData, reasons, totals);
		const rollover = isRecord(record.details) && record.details.kind === "experimental-context-rollover";
		if (record.details !== undefined && !rollover) addReason(reasons, "unsupported-rollover-details");
		entry.compaction = {
			summaryUtf8Bytes: summary.utf8Bytes,
			summaryUtf16Units: summary.utf16Units,
			shortSummaryUtf8Bytes,
			tokensBefore: numericField(record, "tokensBefore"),
			tokensAfter: numericField(record, "tokensAfter"),
			method,
			firstKeptOrdinal: null,
			firstKeptState: firstKeptSourceId === "" ? "empty" : "missing",
			providerReplayThroughOrdinal: null,
			providerReplayThroughState: providerReplayThroughSourceId === undefined ? "absent" : "missing",
			rollover,
			preserve,
		};
	} else if (base.type === "custom") {
		entry.retainedOpaqueLineBytes = physicalBytes;
		addPayload(totals, "opaqueStoredLineBytes", physicalBytes);
		if (record.customType === "experimental_context_notes") {
			if (!isRecord(record.data) || record.data.version !== 1 || typeof record.data.text !== "string") {
				addReason(reasons, "unsupported-context-notes");
				return undefined;
			}
			const metrics = textMetrics(record.data.text);
			entry.customType = "context-notes";
			entry.content = {
				kind: "string",
				...metrics,
				blockCounts: emptyBlockCounts(),
				imageDataUtf8Bytes: 0,
				toolCallCount: 0,
			};
			addPayload(totals, "contentTextUtf8Bytes", metrics.utf8Bytes);
			isContextNotes = metrics.utf8Bytes > 0;
		}
	} else if (base.type === "session_init") {
		entry.retainedOpaqueLineBytes = physicalBytes;
		addPayload(totals, "opaqueStoredLineBytes", physicalBytes);
	}
	return {
		sourceId: base.sourceId,
		parentSourceId: base.parentSourceId,
		activeLeafSourceId: base.activeLeafSourceId,
		entryTimestampMs: base.entryTimestampMs,
		messageTimestampMs,
		toolCallIds,
		toolResultCallId,
		firstKeptSourceId,
		providerReplayThroughSourceId,
		isContextNotes,
		isRolloverRequest,
		entry,
	};
}

function resolveReferences(descriptors: InternalDescriptor[], reasons: Set<IncompleteReason>): Map<string, number> {
	const bySourceId = new Map<string, number>();
	for (const descriptor of descriptors) {
		if (bySourceId.has(descriptor.sourceId)) addReason(reasons, "duplicate-entry-id");
		else bySourceId.set(descriptor.sourceId, descriptor.entry.ordinal);
	}
	for (const descriptor of descriptors) {
		if (descriptor.parentSourceId === null) descriptor.entry.parent = { state: "root", ordinal: null };
		else {
			const parentOrdinal = bySourceId.get(descriptor.parentSourceId);
			descriptor.entry.parent = parentOrdinal === undefined ? { state: "missing", ordinal: null } : { state: "ordinal", ordinal: parentOrdinal };
			if (parentOrdinal === undefined) addReason(reasons, "missing-parent");
		}
		if (descriptor.activeLeafSourceId === undefined) descriptor.entry.activeLeaf = { state: "absent", ordinal: null };
		else if (descriptor.activeLeafSourceId === null) descriptor.entry.activeLeaf = { state: "null", ordinal: null };
		else {
			const activeLeafOrdinal = bySourceId.get(descriptor.activeLeafSourceId);
			descriptor.entry.activeLeaf = activeLeafOrdinal === undefined ? { state: "dangling", ordinal: null } : { state: "ordinal", ordinal: activeLeafOrdinal };
		}
		const compaction = descriptor.entry.compaction;
		if (!compaction) continue;
		if (descriptor.firstKeptSourceId && descriptor.firstKeptSourceId !== "") {
			const ordinal = bySourceId.get(descriptor.firstKeptSourceId);
			compaction.firstKeptOrdinal = ordinal ?? null;
			compaction.firstKeptState = ordinal === undefined ? "missing" : "ordinal";
			if (ordinal === undefined) addReason(reasons, "unresolved-compaction-boundary");
		}
		if (descriptor.providerReplayThroughSourceId !== undefined) {
			const ordinal = bySourceId.get(descriptor.providerReplayThroughSourceId);
			compaction.providerReplayThroughOrdinal = ordinal ?? null;
			compaction.providerReplayThroughState = ordinal === undefined ? "missing" : "ordinal";
			if (ordinal === undefined) addReason(reasons, "unresolved-compaction-boundary");
		}
	}
	return bySourceId;
}

function resolveLeafOrdinal(descriptors: readonly InternalDescriptor[], bySourceId: ReadonlyMap<string, number>): number | null {
	const last = descriptors.at(-1);
	if (!last || last.activeLeafSourceId === null) return null;
	if (last.activeLeafSourceId === undefined || last.activeLeafSourceId === last.sourceId) return last.entry.ordinal;
	const replayed = bySourceId.get(last.activeLeafSourceId);
	if (replayed !== undefined) return replayed;
	for (let index = descriptors.length - 1; index >= 0; index--) {
		const candidate = descriptors[index]!;
		if (candidate.activeLeafSourceId === undefined || candidate.activeLeafSourceId === candidate.sourceId) return candidate.entry.ordinal;
	}
	return null;
}

function buildBranch(leafOrdinal: number | null, descriptors: readonly InternalDescriptor[], reasons: Set<IncompleteReason>): number[] {
	if (leafOrdinal === null) return [];
	const byOrdinal = new Map(descriptors.map(descriptor => [descriptor.entry.ordinal, descriptor]));
	const seen = new Set<number>();
	const branch: number[] = [];
	let ordinal = leafOrdinal;
	while (true) {
		if (seen.has(ordinal)) {
			addReason(reasons, "parent-cycle");
			return [];
		}
		seen.add(ordinal);
		const descriptor = byOrdinal.get(ordinal);
		if (!descriptor) {
			addReason(reasons, "missing-selected-leaf");
			return [];
		}
		branch.push(ordinal);
		if (descriptor.entry.parent.state === "root") break;
		if (descriptor.entry.parent.state !== "ordinal" || descriptor.entry.parent.ordinal === null) {
			addReason(reasons, "missing-parent");
			return [];
		}
		ordinal = descriptor.entry.parent.ordinal;
	}
	branch.reverse();
	return branch;
}

function emitsContext(descriptor: InternalDescriptor): boolean {
	if (descriptor.entry.type === "message") return !(descriptor.entry.role === "assistant" && (descriptor.entry.retryRecovery || descriptor.entry.emptyErrorTurn));
	if (descriptor.entry.type === "custom_message") return descriptor.entry.customType !== "prewalk-plan" && descriptor.entry.customType !== "vibe";
	return descriptor.entry.type === "branch_summary" && (descriptor.entry.branchSummaryUtf8Bytes ?? 0) > 0;
}

function reconstructActiveContext(branch: readonly number[], descriptors: readonly InternalDescriptor[], reasons: Set<IncompleteReason>) {
	const byOrdinal = new Map(descriptors.map(descriptor => [descriptor.entry.ordinal, descriptor]));
	const pathEntries = branch.map(ordinal => byOrdinal.get(ordinal)).filter((entry): entry is InternalDescriptor => entry !== undefined);
	let compactionIndex = -1;
	let resetIndex = -1;
	for (let index = 0; index < pathEntries.length; index++) {
		if (pathEntries[index]!.entry.type === "compaction") compactionIndex = index;
		if (pathEntries[index]!.entry.type === "reset_boundary") resetIndex = index;
	}
	const items: ({ kind: "source"; ordinal: number } | { kind: "compaction-summary" })[] = [];
	const appendRange = (start: number, end: number) => {
		for (let index = start; index < end; index++) {
			const descriptor = pathEntries[index]!;
			if (emitsContext(descriptor)) items.push({ kind: "source", ordinal: descriptor.entry.ordinal });
		}
	};
	let providerReplayMode: "none" | "openai-replacement" | "anthropic-replay" = "none";
	if (resetIndex >= 0 && resetIndex > compactionIndex) {
		appendRange(resetIndex + 1, pathEntries.length);
	} else if (compactionIndex >= 0) {
		const compactionEntry = pathEntries[compactionIndex]!;
		const compaction = compactionEntry.entry.compaction;
		if (!compaction) {
			addReason(reasons, "unresolved-compaction-boundary");
			return { items: [], latestCompactionOrdinal: null, latestResetOrdinal: null, resetRelation: "none" as const, providerReplayMode, notesEntryOrdinal: null };
		}
		items.push({ kind: "compaction-summary" });
		const hasOpenAiReplacement = compaction.preserve.openAiRemote !== undefined;
		const hasAnthropicReplay = compaction.preserve.anthropic !== undefined;
		if (hasOpenAiReplacement) {
			providerReplayMode = "openai-replacement";
			if (compaction.providerReplayThroughState === "ordinal" && compaction.providerReplayThroughOrdinal !== null) {
				const replayIndex = pathEntries.findIndex(entry => entry.entry.ordinal === compaction.providerReplayThroughOrdinal);
				if (replayIndex < 0 || replayIndex >= compactionIndex) addReason(reasons, "unresolved-compaction-boundary");
				else appendRange(replayIndex + 1, compactionIndex);
			}
		} else {
			let retainedStart = -1;
			if (compaction.firstKeptState === "ordinal" && compaction.firstKeptOrdinal !== null) retainedStart = pathEntries.findIndex(entry => entry.entry.ordinal === compaction.firstKeptOrdinal);
			if (retainedStart < 0 && hasAnthropicReplay && compaction.firstKeptState === "empty" && compaction.providerReplayThroughOrdinal !== null) {
				const replayIndex = pathEntries.findIndex(entry => entry.entry.ordinal === compaction.providerReplayThroughOrdinal);
				retainedStart = replayIndex < 0 ? -1 : replayIndex + 1;
			}
			if (retainedStart < 0 || retainedStart >= compactionIndex) addReason(reasons, "unresolved-compaction-boundary");
			else appendRange(retainedStart, compactionIndex);
			if (hasAnthropicReplay) providerReplayMode = "anthropic-replay";
		}
		if (compaction.rollover) {
			const retainedStart = compaction.firstKeptOrdinal === null ? Number.POSITIVE_INFINITY : pathEntries.findIndex(entry => entry.entry.ordinal === compaction.firstKeptOrdinal);
			for (let index = compactionIndex - 1; index > resetIndex; index--) {
				const candidate = pathEntries[index]!;
				if (!candidate.isRolloverRequest) continue;
				if (index < retainedStart && emitsContext(candidate)) items.push({ kind: "source", ordinal: candidate.entry.ordinal });
				break;
			}
		}
		appendRange(compactionIndex + 1, pathEntries.length);
	} else {
		appendRange(0, pathEntries.length);
	}
	let notesEntryOrdinal: number | null = null;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const descriptor = pathEntries[index]!;
		if (descriptor.entry.type === "reset_boundary") break;
		if (!descriptor.isContextNotes) continue;
		if (descriptor.entry.content?.kind !== "string" && descriptor.entry.content?.kind !== "blocks") {
			addReason(reasons, "unsupported-context-notes");
			break;
		}
		notesEntryOrdinal = descriptor.entry.ordinal;
		const insertAt = providerReplayMode === "anthropic-replay" && items[0]?.kind === "compaction-summary" ? 1 : 0;
		items.splice(insertAt, 0, { kind: "source", ordinal: descriptor.entry.ordinal });
		break;
	}
	return {
		items,
		latestCompactionOrdinal: compactionIndex >= 0 ? pathEntries[compactionIndex]!.entry.ordinal : null,
		latestResetOrdinal: resetIndex >= 0 ? pathEntries[resetIndex]!.entry.ordinal : null,
		resetRelation: resetIndex < 0 ? "none" as const : resetIndex > compactionIndex ? "after-compaction" as const : "before-compaction" as const,
		providerReplayMode,
		notesEntryOrdinal,
	};
}

function remapTimestamps(descriptors: InternalDescriptor[]): void {
	const base = descriptors.reduce((minimum, descriptor) => Math.min(minimum, descriptor.entryTimestampMs), Number.POSITIVE_INFINITY);
	for (const descriptor of descriptors) {
		descriptor.entry.entryTimestampOffsetMs = descriptor.entryTimestampMs - base;
		if (descriptor.messageTimestampMs !== undefined) descriptor.entry.messageTimestampOffsetMs = descriptor.messageTimestampMs - base;
		const snapshot = descriptor.entry.contextSnapshot;
		if (snapshot && snapshot.lastMessageOffsetMs.value !== null) snapshot.lastMessageOffsetMs.value -= base;
		const relations = descriptor.entry.rewriteRelations;
		if (relations && relations.prunedAtOffsetMs.value !== null) relations.prunedAtOffsetMs.value -= base;
		if (relations && relations.historyRewriteAtOffsetMs.value !== null) relations.historyRewriteAtOffsetMs.value -= base;
		const retainedFiles = descriptor.entry.compaction?.preserve.anthropic?.retainedFiles;
		if (retainedFiles) for (const file of retainedFiles) if (file.afterOffsetMs.value !== null) file.afterOffsetMs.value -= base;
	}
}

function attachToolPairs(descriptors: InternalDescriptor[]): void {
	const callOrdinals = new Map<string, number>();
	for (const descriptor of descriptors) for (const id of descriptor.toolCallIds) callOrdinals.set(id, descriptor.entry.ordinal);
	for (const descriptor of descriptors) if (descriptor.toolResultCallId !== undefined) descriptor.entry.toolResultPairOrdinal = callOrdinals.get(descriptor.toolResultCallId) ?? null;
}

function terminalState(leafOrdinal: number | null, descriptors: readonly InternalDescriptor[]) {
	const byOrdinal = new Map(descriptors.map(descriptor => [descriptor.entry.ordinal, descriptor]));
	const calls = new Set<string>();
	const results = new Set<string>();
	let retryRecoveryAssistantCount = 0;
	let emptyErrorAssistantCount = 0;
	for (const descriptor of descriptors) {
		for (const id of descriptor.toolCallIds) calls.add(id);
		if (descriptor.toolResultCallId !== undefined) results.add(descriptor.toolResultCallId);
		if (descriptor.entry.role === "assistant" && descriptor.entry.retryRecovery) retryRecoveryAssistantCount++;
		if (descriptor.entry.role === "assistant" && descriptor.entry.emptyErrorTurn) emptyErrorAssistantCount++;
	}
	let danglingToolCallCount = 0;
	for (const id of calls) if (!results.has(id)) danglingToolCallCount++;
	const leaf = leafOrdinal === null ? undefined : byOrdinal.get(leafOrdinal);
	return {
		lastSelectedRole: leaf?.entry.role ?? "non-message",
		danglingToolCallCount,
		retryRecoveryAssistantCount,
		emptyErrorAssistantCount,
	};
}

async function writeReceipt(output: string, receipt: object): Promise<void> {
	await fs.mkdir(path.dirname(output), { recursive: true });
	const temporary = `${output}.tmp-${process.pid}`;
	await fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`);
	await fs.rename(temporary, output);
}

async function main(): Promise<void> {
	const journal = path.resolve(requiredValue("--journal"));
	const output = path.resolve(requiredValue("--output"));
	const cutoff = requiredValue("--cutoff");
	const prefixBytes = requiredInteger("--prefix-bytes");
	const descriptorLimitBytes = requiredInteger("--descriptor-limit-bytes");
	if (cutoff !== EXPECTED_CUTOFF) throw new Error("--cutoff must be the confirmed incident cutoff");
	if (prefixBytes !== EXPECTED_PREFIX_BYTES) throw new Error("--prefix-bytes must be the confirmed incident prefix");
	if (descriptorLimitBytes !== DESCRIPTOR_OUTPUT_LIMIT_BYTES) throw new Error("--descriptor-limit-bytes must be 16777216");
	const cutoffMs = Date.parse(cutoff);
	if (!Number.isFinite(cutoffMs)) throw new Error("confirmed cutoff is invalid");
	const stat = await fs.stat(journal);
	if (stat.size < prefixBytes) throw new Error("journal is shorter than the confirmed incident prefix");

	const reasons = new Set<IncompleteReason>();
	const counters: Counters = { physicalRows: 0, validSessionEntries: 0, malformedRows: 0, postCutoffRows: 0, selectedRows: 0, selectedBoundaryBytes: 0, largestPhysicalLineBytes: 0, truncatedTrailingBytes: 0, postCutoffInterruptsSelectedPrefix: false };
	const totals = emptyPayloadTotals();
	const descriptors: InternalDescriptor[] = [];
	const hash = createHash("sha256");
	let descriptorBytes = 0;
	let descriptorLimitExceeded = false;
	let sawPostCutoff = false;
	let completedBytes = 0;
	let chunks: Buffer[] = [];
	let lineBytes = 0;
	let oversizedLine = false;

	const ingestLine = (line: Buffer | undefined, physicalBytes: number, endByte: number) => {
		counters.physicalRows++;
		counters.largestPhysicalLineBytes = Math.max(counters.largestPhysicalLineBytes, physicalBytes);
		if (!line || oversizedLine) {
			counters.malformedRows++;
			addReason(reasons, "line-byte-limit");
			return;
		}
		const source = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
		if (source.length === 0) {
			counters.malformedRows++;
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(source.toString("utf8"));
		} catch {
			counters.malformedRows++;
			addReason(reasons, "malformed-json");
			return;
		}
		if (!isRecord(parsed)) {
			counters.malformedRows++;
			addReason(reasons, "invalid-session-entry");
			return;
		}
		if (parsed.type === "session") return;
		if (typeof parsed.timestamp !== "string" || !Number.isFinite(Date.parse(parsed.timestamp))) {
			counters.malformedRows++;
			addReason(reasons, "invalid-session-entry");
			return;
		}
		if (Date.parse(parsed.timestamp) > cutoffMs) {
			sawPostCutoff = true;
			counters.postCutoffRows++;
			return;
		}
		if (sawPostCutoff) {
			counters.postCutoffInterruptsSelectedPrefix = true;
			addReason(reasons, "post-cutoff-interrupts-prefix");
		}
		const base = baseEntry(parsed);
		if (!base) {
			counters.malformedRows++;
			addReason(reasons, typeof parsed.type === "string" ? "invalid-session-entry" : "unknown-entry-type");
			return;
		}
		counters.validSessionEntries++;
		counters.selectedRows++;
		counters.selectedBoundaryBytes = endByte;
		if (descriptorLimitExceeded) return;
		const descriptor = makeDescriptor(parsed, base, counters.validSessionEntries, physicalBytes, reasons, totals);
		if (!descriptor) return;
		const projectedBytes = utf8Bytes(JSON.stringify(descriptor.entry)) + 1;
		if (descriptorBytes + projectedBytes > descriptorLimitBytes - 4096) {
			descriptorLimitExceeded = true;
			addReason(reasons, "descriptor-output-limit");
			return;
		}
		descriptorBytes += projectedBytes;
		descriptors.push(descriptor);
	};

	const stream = createReadStream(journal, { start: 0, end: prefixBytes - 1, highWaterMark: 64 * 1024 });
	for await (const rawChunk of stream) {
		const chunk = Buffer.from(rawChunk);
		hash.update(chunk);
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(0x0a, start);
			const end = newline < 0 ? chunk.length : newline;
			const piece = chunk.subarray(start, end);
			if (!oversizedLine) {
				if (lineBytes + piece.length > MAX_PHYSICAL_LINE_BYTES) {
					oversizedLine = true;
					chunks = [];
				} else if (piece.length > 0) chunks.push(piece);
			}
			lineBytes += piece.length;
			if (newline < 0) break;
			const physicalBytes = lineBytes + 1;
			completedBytes += physicalBytes;
			ingestLine(oversizedLine ? undefined : Buffer.concat(chunks, lineBytes), physicalBytes, completedBytes);
			chunks = [];
			lineBytes = 0;
			oversizedLine = false;
			start = newline + 1;
		}
	}
	if (lineBytes > 0 || oversizedLine) {
		counters.truncatedTrailingBytes = lineBytes;
		addReason(reasons, "truncated-prefix-line");
	}
	const prefixHash = hash.digest("hex");
	const incompleteBase = {
		schemaVersion: 1,
		outcome: "incomplete",
		prefix: { prefixBytes, prefixHash, fileBytesAtRead: stat.size, physicalRecordCount: counters.physicalRows, validSessionEntryCount: counters.validSessionEntries, selectedPreKillByteBoundary: counters.selectedBoundaryBytes, malformedRowCount: counters.malformedRows, postCutoffRowCount: counters.postCutoffRows, postCutoffInterruptsSelectedPrefix: counters.postCutoffInterruptsSelectedPrefix, largestPhysicalLineBytes: counters.largestPhysicalLineBytes, truncatedTrailingBytes: counters.truncatedTrailingBytes },
		bounds: { descriptorOutputLimitBytes: descriptorLimitBytes, descriptorBytes, maximumPhysicalLineBytes: MAX_PHYSICAL_LINE_BYTES },
	};
	if (descriptorLimitExceeded) {
		await writeReceipt(output, { ...incompleteBase, incompleteReasons: [...reasons] });
		process.exitCode = 2;
		return;
	}

	const bySourceId = resolveReferences(descriptors, reasons);
	attachToolPairs(descriptors);
	remapTimestamps(descriptors);
	const leafOrdinal = resolveLeafOrdinal(descriptors, bySourceId);
	const terminal = terminalState(leafOrdinal, descriptors);
	const branch = buildBranch(leafOrdinal, descriptors, reasons);
	const active = reconstructActiveContext(branch, descriptors, reasons);
	const byOrdinal = new Map(descriptors.map(descriptor => [descriptor.entry.ordinal, descriptor]));
	const compactionIndex = active.latestCompactionOrdinal === null ? -1 : branch.indexOf(active.latestCompactionOrdinal);
	let latestAnchorOrdinal: number | null = null;
	for (let index = branch.length - 1; index > compactionIndex; index--) {
		const descriptor = byOrdinal.get(branch[index]!);
		if (descriptor?.entry.role === "assistant" && descriptor.entry.usage?.anchorEligible) {
			latestAnchorOrdinal = descriptor.entry.ordinal;
			break;
		}
	}
	const projectedActiveIndex = latestAnchorOrdinal === null ? -1 : active.items.findIndex(item => item.kind === "source" && item.ordinal === latestAnchorOrdinal);
	const anchorTimestamp = latestAnchorOrdinal === null ? undefined : byOrdinal.get(latestAnchorOrdinal)?.messageTimestampMs;
	const timestampMatchCount = anchorTimestamp === undefined ? 0 : active.items.filter(item => item.kind === "source" && byOrdinal.get(item.ordinal)?.messageTimestampMs === anchorTimestamp).length;
	const receipt = {
		schemaVersion: 1,
		outcome: reasons.size === 0 ? "complete" : "incomplete",
		prefix: incompleteBase.prefix,
		bounds: incompleteBase.bounds,
		entries: descriptors.map(descriptor => descriptor.entry),
		replay: { resolvedLeafOrdinal: leafOrdinal, branchEntryOrdinals: branch, branchEntryCount: branch.length, latestCompactionOrdinal: active.latestCompactionOrdinal, latestResetBoundaryOrdinal: active.latestResetOrdinal, resetBoundaryRelation: active.resetRelation, providerReplayMode: active.providerReplayMode },
		activeContext: { items: active.items, messageCount: active.items.length, notesEntryOrdinal: active.notesEntryOrdinal },
		terminal,
		anchor: { latestEligibleBranchAnchorOrdinal: latestAnchorOrdinal, projectedActiveIndex, timestampMatchCount, pendingSnapshot: "fresh-session-absent", compactionEpoch: 0, accountingBranch: latestAnchorOrdinal !== null && projectedActiveIndex >= 0 ? "provider-anchor-candidate" : "unanchored-active-count" },
		payloadTotals: totals,
		incompleteReasons: [...reasons],
	};
	if (utf8Bytes(JSON.stringify(receipt)) > descriptorLimitBytes) {
		addReason(reasons, "output-limit");
		await writeReceipt(output, { ...incompleteBase, incompleteReasons: [...reasons] });
		process.exitCode = 2;
		return;
	}
	await writeReceipt(output, receipt);
	if (reasons.size > 0) process.exitCode = 2;
}

void main().catch(() => {
	process.stderr.write("incident-state scalar projection failed\n");
	process.exitCode = 1;
});
