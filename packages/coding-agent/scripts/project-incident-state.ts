#!/usr/bin/env bun

/**
 * Projects only scalar state from the confirmed killed-session boundary.
 * It never emits source IDs, text, URLs, commands, object keys, images, blobs,
 * or provider payloads. Every scan is bounded to the known pre-kill prefix.
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

const EXPECTED_PREFIX_BYTES = 146_751_304;
const EXPECTED_CUTOFF = "2026-10-23T03:25:20Z";
const DESCRIPTOR_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_PHYSICAL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPED_ENTRIES = 2_048;
const MAX_SHAPE_DEPTH = 12;
const MAX_SHAPE_NODES = 512;
const MAX_SHAPE_CONTAINER_ITEMS = 128;
const MAX_AGGREGATE_NODES = 100_000;

const ENTRY_TYPE_CODE: Record<string, number> = {
	message: 1,
	model_usage: 2,
	thinking_level_change: 3,
	model_change: 4,
	service_tier_change: 5,
	compaction: 6,
	branch_summary: 7,
	custom: 8,
	custom_message: 9,
	label: 10,
	title_change: 11,
	ttsr_injection: 12,
	session_init: 13,
	mode_change: 14,
	credential_pin: 15,
	reset_boundary: 16,
};
const ROLE_CODE: Record<string, number> = { none: 0, user: 1, developer: 2, assistant: 3, toolResult: 4, unknown: 5 };
const STOP_REASON: Record<string, true> = { stop: true, length: true, toolUse: true, error: true, aborted: true };
const COMPACTION_METHOD: Record<string, true> = { remote: true, snapcompact: true, handoff: true, soft: true, shake: true };
const PRESERVE_KEY: Record<string, true> = { openaiRemoteCompaction: true, anthropicCompaction: true, snapcompact: true };

type EntryType = keyof typeof ENTRY_TYPE_CODE;
type Role = "none" | "user" | "developer" | "assistant" | "toolResult" | "unknown";
type StopReason = keyof typeof STOP_REASON;
type IncompleteReason =
	| "line-byte-limit"
	| "truncated-prefix-line"
	| "malformed-json"
	| "invalid-session-entry"
	| "invalid-entry-id"
	| "unknown-entry-type"
	| "duplicate-entry-id"
	| "post-cutoff-before-boundary"
	| "missing-parent"
	| "parent-cycle"
	| "missing-selected-leaf"
	| "unresolved-compaction-boundary"
	| "scope-entry-limit"
	| "projection-desync"
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
	| "historical-payload-shape-limit"
	| "output-limit";

type JsonRecord = Record<string, unknown>;
type NumericScalar = { present: boolean; value: number | null };
type ScalarShape =
	| { kind: "null" | "boolean" | "number" }
	| { kind: "string"; utf8Bytes: number; utf16Units: number }
	| { kind: "array"; length: number; values: ScalarShape[] }
	| { kind: "object"; propertyCount: number; values: ScalarShape[] };

type BaseEntry = {
	type: EntryType;
	sourceId: string;
	parentSourceId: string | null;
	activeLeafSourceId: string | null | undefined;
	timestampMs: number;
};

type Topology = BaseEntry & {
	ordinal: number;
	parentOrdinal: number | null;
	activeLeafState: 0 | 1 | 2 | 3;
	activeLeafOrdinal: number | null;
	role: Role;
	messageTimestampMs: number | null;
	anchorEligible: boolean;
	retryRecovery: boolean;
	emptyErrorTurn: boolean;
	hasSummary: boolean;
	customCategory: "context-notes" | "prewalk-plan" | "vibe" | "irc-incoming-parent" | "other" | "none";
	isRolloverRequest: boolean;
	physicalBytes: number;
	firstKeptSourceId: string | undefined;
	firstKeptOrdinal: number | null;
	providerReplayThroughSourceId: string | undefined;
	providerReplayThroughOrdinal: number | null;
	preserve: { openaiRemote: boolean; anthropic: boolean; snapcompact: boolean; unrecognizedKeyCount: number };
	rollover: boolean;
};

type Counts = {
	physicalRows: number;
	validSessionEntries: number;
	malformedRows: number;
	postCutoffRows: number;
	largestPhysicalLineBytes: number;
	truncatedTrailingBytes: number;
};

type AggregateBucket = {
	typeCode: number;
	roleCode: number;
	rows: number;
	physicalBytes: number;
	stringUtf8Bytes: number;
	imageDataUtf8Bytes: number;
	arrayCount: number;
	objectCount: number;
	maximumDepth: number;
};

type CompactionDetail = {
	summaryUtf8Bytes: number;
	summaryUtf16Units: number;
	shortSummaryUtf8Bytes: number;
	tokensBefore: NumericScalar;
	tokensAfter: NumericScalar;
	method: string;
	firstKeptOrdinal: number | null;
	providerReplayThroughOrdinal: number | null;
	preserve: PreserveDetail;
};

type RetainedFileScalar = { textUtf8Bytes: number; afterOffsetMs: NumericScalar };

type PreserveDetail = {
	recognizedKeys: (keyof typeof PRESERVE_KEY)[];
	unrecognizedKeyCount: number;
	openaiRemote?: { version: "v1" | "v2" | "unknown"; replacementHistoryCount: number; replacementShapes: ScalarShape[]; compactionItemKind: string; compactionItemUtf8Bytes: number; usedTokens: NumericScalar };
	anthropic?: { contentUtf8Bytes: number; signatureUtf8Bytes: number; encryptedContentUtf8Bytes: number; filesTextUtf8Bytes: number; retainedFiles: RetainedFileScalar[]; toolChangeShapes: ScalarShape[]; exactTail: boolean; usedTokens: NumericScalar };
	snapcompact?: ArchiveDetail;
};

type ArchiveDetail = {
	frameCount: number;
	frames: { dataUtf8Bytes: number; cols: NumericScalar; rows: NumericScalar; chars: NumericScalar }[];
	textUtf8Bytes: number;
	textHeadUtf8Bytes: number;
	textTailUtf8Bytes: number;
	totalChars: NumericScalar;
	truncatedChars: NumericScalar;
	withoutThinking: { present: boolean; summaryUtf8Bytes: number; archive: ArchiveDetail | null };
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

function metrics(value: unknown): { utf8Bytes: number; utf16Units: number } {
	const text = typeof value === "string" ? value : "";
	return { utf8Bytes: utf8Bytes(text), utf16Units: text.length };
}

function numeric(record: JsonRecord | undefined, field: string): NumericScalar {
	const present = record !== undefined && Object.hasOwn(record, field);
	const value = record?.[field];
	return { present, value: typeof value === "number" && Number.isFinite(value) ? value : null };
}

function offsetNumeric(record: JsonRecord | undefined, field: string, baseTimestamp: number): NumericScalar {
	const scalar = numeric(record, field);
	if (scalar.value !== null) scalar.value -= baseTimestamp;
	return scalar;
}

function addReason(reasons: Set<IncompleteReason>, reason: IncompleteReason): void {
	reasons.add(reason);
}

function knownEntryType(value: unknown): EntryType | undefined {
	return typeof value === "string" && Object.hasOwn(ENTRY_TYPE_CODE, value) ? (value as EntryType) : undefined;
}

function roleFor(message: JsonRecord | undefined): Role {
	if (!message || typeof message.role !== "string" || !Object.hasOwn(ROLE_CODE, message.role)) return "unknown";
	return message.role as Role;
}

function baseEntry(record: JsonRecord): BaseEntry | undefined {
	const type = knownEntryType(record.type);
	if (!type) return undefined;
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 512) return undefined;
	if (record.parentId !== null && typeof record.parentId !== "string") return undefined;
	if (typeof record.timestamp !== "string") return undefined;
	const timestampMs = Date.parse(record.timestamp);
	if (!Number.isFinite(timestampMs)) return undefined;
	if (record.activeLeafId !== undefined && record.activeLeafId !== null && typeof record.activeLeafId !== "string") return undefined;
	return {
		type,
		sourceId: record.id,
		parentSourceId: record.parentId,
		activeLeafSourceId: record.activeLeafId as string | null | undefined,
		timestampMs,
	};
}

function customCategory(value: unknown): Topology["customCategory"] {
	if (value === "experimental_context_notes") return "context-notes";
	if (value === "prewalk-plan") return "prewalk-plan";
	if (value === "vibe-mode-context") return "vibe";
	if (value === "irc:incoming") return "irc-incoming-parent";
	return "other";
}

function hasAnchorUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const input = typeof value.input === "number" ? value.input : 0;
	const output = typeof value.output === "number" ? value.output : 0;
	const cacheRead = typeof value.cacheRead === "number" ? value.cacheRead : 0;
	const cacheWrite = typeof value.cacheWrite === "number" ? value.cacheWrite : 0;
	const contextTokens = typeof value.contextTokens === "number" ? value.contextTokens : 0;
	const totalTokens = typeof value.totalTokens === "number" ? value.totalTokens : input + output + cacheRead + cacheWrite;
	const orchestration = isRecord(value.orchestration) ? value.orchestration : undefined;
	const orchestrationTotal = (typeof orchestration?.input === "number" ? orchestration.input : 0) + (typeof orchestration?.output === "number" ? orchestration.output : 0) + (typeof orchestration?.cacheRead === "number" ? orchestration.cacheRead : 0);
	return contextTokens > 0 || input + cacheRead + cacheWrite > 0 || Math.max(0, totalTokens - orchestrationTotal) > output;
}

function emptyErrorTurn(message: JsonRecord): boolean {
	if (message.stopReason !== "error" || !Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (!isRecord(block) || typeof block.type !== "string") return false;
		if (block.type === "fallback") continue;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim().length === 0) continue;
		if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length === 0 && (typeof block.thinkingSignature !== "string" || block.thinkingSignature.trim().length === 0)) continue;
		if (block.type === "redactedThinking" && typeof block.data === "string" && block.data.trim().length === 0) continue;
		return false;
	}
	return true;
}

function compactionHint(record: JsonRecord) {
	const preserve = isRecord(record.preserveData) ? record.preserveData : undefined;
	const keys = preserve ? Object.keys(preserve) : [];
	const unrecognizedKeyCount = keys.filter(key => !Object.hasOwn(PRESERVE_KEY, key)).length;
	return {
		firstKeptSourceId: typeof record.firstKeptEntryId === "string" ? record.firstKeptEntryId : undefined,
		providerReplayThroughSourceId: typeof record.providerReplayThroughEntryId === "string" ? record.providerReplayThroughEntryId : undefined,
		preserve: {
			openaiRemote: preserve?.openaiRemoteCompaction !== undefined,
			anthropic: preserve?.anthropicCompaction !== undefined,
			snapcompact: preserve?.snapcompact !== undefined,
			unrecognizedKeyCount,
		},
		rollover: isRecord(record.details) && record.details.kind === "experimental-context-rollover",
	};
}

function topologyFor(record: JsonRecord, base: BaseEntry, ordinal: number, physicalBytes: number, reasons: Set<IncompleteReason>): Topology {
	let role: Role = "none";
	let messageTimestampMs: number | null = null;
	let anchorEligible = false;
	let retryRecovery = false;
	let isEmptyError = false;
	let hasSummary = false;
	let category: Topology["customCategory"] = "none";
	let isRolloverRequest = false;
	let firstKeptSourceId: string | undefined;
	let providerReplayThroughSourceId: string | undefined;
	let preserve = { openaiRemote: false, anthropic: false, snapcompact: false, unrecognizedKeyCount: 0 };
	let rollover = false;

	if (base.type === "message") {
		const message = isRecord(record.message) ? record.message : undefined;
		role = roleFor(message);
		if (message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) messageTimestampMs = message.timestamp;
		if (role === "assistant" && message) {
			const stopReason =
				typeof message.stopReason === "string" && Object.hasOwn(STOP_REASON, message.stopReason)
					? (message.stopReason as StopReason)
					: undefined;
			anchorEligible = stopReason !== "aborted" && stopReason !== "error" && hasAnchorUsage(message.usage);
			retryRecovery = isRecord(message.retryRecovery);
			isEmptyError = emptyErrorTurn(message);
		}
	} else if (base.type === "custom_message") {
		category = customCategory(record.customType);
		isRolloverRequest =
			category === "irc-incoming-parent" && isRecord(record.details) && record.details.fromParent === true;
	} else if (base.type === "branch_summary") {
		hasSummary = typeof record.summary === "string" && record.summary.length > 0;
	} else if (base.type === "custom" && record.customType === "experimental_context_notes") {
		category = "context-notes";
	} else if (base.type === "compaction") {
		const hint = compactionHint(record);
		firstKeptSourceId = hint.firstKeptSourceId;
		providerReplayThroughSourceId = hint.providerReplayThroughSourceId;
		preserve = hint.preserve;
		rollover = hint.rollover;
	}
	return {
		...base,
		ordinal,
		parentOrdinal: null,
		activeLeafState: base.activeLeafSourceId === undefined ? 0 : base.activeLeafSourceId === null ? 1 : 3,
		activeLeafOrdinal: null,
		role,
		messageTimestampMs,
		anchorEligible,
		retryRecovery,
		emptyErrorTurn: isEmptyError,
		hasSummary,
		customCategory: category,
		isRolloverRequest,
		physicalBytes,
		firstKeptSourceId,
		firstKeptOrdinal: null,
		providerReplayThroughSourceId,
		providerReplayThroughOrdinal: null,
		preserve,
		rollover,
	};
}

function resolveTopology(entries: Topology[], reasons: Set<IncompleteReason>): Map<string, number> {
	const bySourceId = new Map<string, number>();
	for (const entry of entries) {
		if (bySourceId.has(entry.sourceId)) addReason(reasons, "duplicate-entry-id");
		else bySourceId.set(entry.sourceId, entry.ordinal);
	}
	for (const entry of entries) {
		if (entry.parentSourceId === null) entry.parentOrdinal = 0;
		else {
			entry.parentOrdinal = bySourceId.get(entry.parentSourceId) ?? null;
			if (entry.parentOrdinal === null) addReason(reasons, "missing-parent");
		}
		if (entry.activeLeafSourceId === undefined) entry.activeLeafState = 0;
		else if (entry.activeLeafSourceId === null) entry.activeLeafState = 1;
		else {
			entry.activeLeafOrdinal = bySourceId.get(entry.activeLeafSourceId) ?? null;
			entry.activeLeafState = entry.activeLeafOrdinal === null ? 3 : 2;
		}
		if (entry.type !== "compaction") continue;
		if (entry.firstKeptSourceId && entry.firstKeptSourceId !== "") {
			entry.firstKeptOrdinal = bySourceId.get(entry.firstKeptSourceId) ?? null;
			if (entry.firstKeptOrdinal === null) addReason(reasons, "unresolved-compaction-boundary");
		}
		if (entry.providerReplayThroughSourceId !== undefined) {
			entry.providerReplayThroughOrdinal = bySourceId.get(entry.providerReplayThroughSourceId) ?? null;
			if (entry.providerReplayThroughOrdinal === null) addReason(reasons, "unresolved-compaction-boundary");
		}
	}
	return bySourceId;
}

function resolveLeaf(entries: readonly Topology[], bySourceId: ReadonlyMap<string, number>): number | null {
	const last = entries.at(-1);
	if (!last || last.activeLeafSourceId === null) return null;
	if (last.activeLeafSourceId === undefined || last.activeLeafSourceId === last.sourceId) return last.ordinal;
	const replayed = bySourceId.get(last.activeLeafSourceId);
	if (replayed !== undefined) return replayed;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.activeLeafSourceId === undefined || entry.activeLeafSourceId === entry.sourceId) return entry.ordinal;
	}
	return null;
}

function branchFor(leafOrdinal: number | null, entries: readonly Topology[], reasons: Set<IncompleteReason>): number[] {
	if (leafOrdinal === null) return [];
	const byOrdinal = new Map(entries.map(entry => [entry.ordinal, entry]));
	const seen = new Set<number>();
	const branch: number[] = [];
	let ordinal = leafOrdinal;
	while (true) {
		if (seen.has(ordinal)) {
			addReason(reasons, "parent-cycle");
			return [];
		}
		seen.add(ordinal);
		const entry = byOrdinal.get(ordinal);
		if (!entry) {
			addReason(reasons, "missing-selected-leaf");
			return [];
		}
		branch.push(ordinal);
		if (entry.parentOrdinal === 0) break;
		if (entry.parentOrdinal === null) {
			addReason(reasons, "missing-parent");
			return [];
		}
		ordinal = entry.parentOrdinal;
	}
	branch.reverse();
	return branch;
}

function emitsContext(entry: Topology): boolean {
	if (entry.type === "message") return !(entry.role === "assistant" && (entry.retryRecovery || entry.emptyErrorTurn));
	if (entry.type === "custom_message") return entry.customCategory !== "prewalk-plan" && entry.customCategory !== "vibe";
	return entry.type === "branch_summary" && entry.hasSummary;
}

function scopeAndContext(branch: readonly number[], entries: readonly Topology[], reasons: Set<IncompleteReason>) {
	const byOrdinal = new Map(entries.map(entry => [entry.ordinal, entry]));
	const pathEntries = branch.map(ordinal => byOrdinal.get(ordinal)).filter((entry): entry is Topology => entry !== undefined);
	let compactionIndex = -1;
	let resetIndex = -1;
	for (let index = 0; index < pathEntries.length; index++) {
		if (pathEntries[index]!.type === "compaction") compactionIndex = index;
		if (pathEntries[index]!.type === "reset_boundary") resetIndex = index;
	}
	const scope = new Set<number>();
	const activeItems: ({ kind: "source"; ordinal: number } | { kind: "compaction-summary" })[] = [];
	const include = (index: number, active: boolean) => {
		const entry = pathEntries[index]!;
		scope.add(entry.ordinal);
		if (active && emitsContext(entry)) activeItems.push({ kind: "source", ordinal: entry.ordinal });
	};
	let providerReplayMode: "none" | "openai-replacement" | "anthropic-replay" = "none";
	if (resetIndex >= 0 && resetIndex > compactionIndex) {
		for (let index = resetIndex + 1; index < pathEntries.length; index++) include(index, true);
	} else if (compactionIndex >= 0) {
		const compaction = pathEntries[compactionIndex]!;
		scope.add(compaction.ordinal);
		activeItems.push({ kind: "compaction-summary" });
		if (compaction.preserve.openaiRemote) {
			providerReplayMode = "openai-replacement";
			if (compaction.providerReplayThroughOrdinal !== null) {
				const replayIndex = pathEntries.findIndex(entry => entry.ordinal === compaction.providerReplayThroughOrdinal);
				if (replayIndex < 0 || replayIndex >= compactionIndex) addReason(reasons, "unresolved-compaction-boundary");
				else for (let index = replayIndex + 1; index < compactionIndex; index++) include(index, true);
			}
		} else {
			let retainedStart = -1;
			if (compaction.firstKeptSourceId === "" && compaction.preserve.anthropic && compaction.providerReplayThroughOrdinal !== null) {
				const replayIndex = pathEntries.findIndex(entry => entry.ordinal === compaction.providerReplayThroughOrdinal);
				retainedStart = replayIndex < 0 ? -1 : replayIndex + 1;
			} else if (compaction.firstKeptOrdinal !== null) {
				retainedStart = pathEntries.findIndex(entry => entry.ordinal === compaction.firstKeptOrdinal);
			}
			if (retainedStart < 0 || retainedStart >= compactionIndex) addReason(reasons, "unresolved-compaction-boundary");
			else for (let index = retainedStart; index < compactionIndex; index++) include(index, true);
			if (compaction.preserve.anthropic) providerReplayMode = "anthropic-replay";
		}
		if (compaction.rollover) {
			const retainedStart = compaction.firstKeptOrdinal === null ? Number.POSITIVE_INFINITY : pathEntries.findIndex(entry => entry.ordinal === compaction.firstKeptOrdinal);
			for (let index = compactionIndex - 1; index > resetIndex; index--) {
				const candidate = pathEntries[index]!;
				if (!candidate.isRolloverRequest) continue;
				if (index < retainedStart && emitsContext(candidate)) {
					scope.add(candidate.ordinal);
					activeItems.push({ kind: "source", ordinal: candidate.ordinal });
				}
				break;
			}
		}
		for (let index = compactionIndex + 1; index < pathEntries.length; index++) include(index, true);
	} else {
		for (let index = 0; index < pathEntries.length; index++) include(index, true);
	}
	let notesEntryOrdinal: number | null = null;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index]!;
		if (entry.type === "reset_boundary") break;
		if (entry.customCategory !== "context-notes") continue;
		notesEntryOrdinal = entry.ordinal;
		scope.add(entry.ordinal);
		const insertAt = providerReplayMode === "anthropic-replay" && activeItems[0]?.kind === "compaction-summary" ? 1 : 0;
		activeItems.splice(insertAt, 0, { kind: "source", ordinal: entry.ordinal });
		break;
	}
	if (scope.size > MAX_SCOPED_ENTRIES) addReason(reasons, "scope-entry-limit");
	return {
		scope,
		activeItems,
		latestCompactionOrdinal: compactionIndex >= 0 ? pathEntries[compactionIndex]!.ordinal : null,
		latestResetBoundaryOrdinal: resetIndex >= 0 ? pathEntries[resetIndex]!.ordinal : null,
		resetBoundaryRelation: resetIndex < 0 ? "none" : resetIndex > compactionIndex ? "after-compaction" : "before-compaction",
		providerReplayMode,
		notesEntryOrdinal,
	};
}

function shape(value: unknown, reasons: Set<IncompleteReason>, depth = 0, budget: { nodes: number } = { nodes: 0 }): ScalarShape | undefined {
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
	if (typeof value === "string") return { kind: "string", ...metrics(value) };
	if (Array.isArray(value)) {
		if (value.length > MAX_SHAPE_CONTAINER_ITEMS) {
			addReason(reasons, "shape-container-limit");
			return undefined;
		}
		const values: ScalarShape[] = [];
		for (const item of value) {
			const child = shape(item, reasons, depth + 1, budget);
			if (!child) return undefined;
			values.push(child);
		}
		return { kind: "array", length: value.length, values };
	}
	if (isRecord(value)) {
		const values = Object.values(value);
		if (values.length > MAX_SHAPE_CONTAINER_ITEMS) {
			addReason(reasons, "shape-container-limit");
			return undefined;
		}
		const children: ScalarShape[] = [];
		for (const item of values) {
			const child = shape(item, reasons, depth + 1, budget);
			if (!child) return undefined;
			children.push(child);
		}
		return { kind: "object", propertyCount: values.length, values: children };
	}
	addReason(reasons, "shape-node-limit");
	return undefined;
}

function archiveDetail(value: unknown, reasons: Set<IncompleteReason>, includeVariant = true): ArchiveDetail | undefined {
	if (!isRecord(value) || !Array.isArray(value.frames)) {
		addReason(reasons, "unsupported-snapcompact-archive");
		return undefined;
	}
	const allowed = { frames: true, totalChars: true, truncatedChars: true, text: true, textHead: true, textTail: true, withoutThinking: true };
	if (Object.keys(value).some(key => !Object.hasOwn(allowed, key))) {
		addReason(reasons, "unsupported-snapcompact-archive");
		return undefined;
	}
	const frames: ArchiveDetail["frames"] = [];
	for (const frame of value.frames) {
		if (!isRecord(frame) || typeof frame.data !== "string" || typeof frame.mimeType !== "string") {
			addReason(reasons, "unsupported-snapcompact-archive");
			return undefined;
		}
		frames.push({ dataUtf8Bytes: utf8Bytes(frame.data), cols: numeric(frame, "cols"), rows: numeric(frame, "rows"), chars: numeric(frame, "chars") });
	}
	let withoutThinking: ArchiveDetail["withoutThinking"] = { present: false, summaryUtf8Bytes: 0, archive: null };
	if (includeVariant && value.withoutThinking !== undefined) {
		if (!isRecord(value.withoutThinking) || typeof value.withoutThinking.summary !== "string") {
			addReason(reasons, "unsupported-snapcompact-archive");
			return undefined;
		}
		const nested = archiveDetail(value.withoutThinking.archive, reasons, false);
		if (!nested) return undefined;
		withoutThinking = { present: true, summaryUtf8Bytes: utf8Bytes(value.withoutThinking.summary), archive: nested };
	}
	return {
		frameCount: frames.length,
		frames,
		textUtf8Bytes: utf8Bytes(typeof value.text === "string" ? value.text : ""),
		textHeadUtf8Bytes: utf8Bytes(typeof value.textHead === "string" ? value.textHead : ""),
		textTailUtf8Bytes: utf8Bytes(typeof value.textTail === "string" ? value.textTail : ""),
		totalChars: numeric(value, "totalChars"),
		truncatedChars: numeric(value, "truncatedChars"),
		withoutThinking,
	};
}

function preserveDetail(value: unknown, reasons: Set<IncompleteReason>, baseTimestamp: number): PreserveDetail {
	if (!isRecord(value)) {
		if (value !== undefined) addReason(reasons, "unsupported-compaction-preserve-data");
		return { recognizedKeys: [], unrecognizedKeyCount: value === undefined ? 0 : 1 };
	}
	const recognizedKeys = Object.keys(value).filter((key): key is keyof typeof PRESERVE_KEY => Object.hasOwn(PRESERVE_KEY, key));
	const unrecognizedKeyCount = Object.keys(value).length - recognizedKeys.length;
	if (unrecognizedKeyCount > 0) addReason(reasons, "unsupported-compaction-preserve-data");
	const result: PreserveDetail = { recognizedKeys, unrecognizedKeyCount };
	const remote = value.openaiRemoteCompaction;
	if (remote !== undefined) {
		if (!isRecord(remote) || !Array.isArray(remote.replacementHistory)) addReason(reasons, "unsupported-provider-replay");
		else {
			const replacementShapes: ScalarShape[] = [];
			for (const item of remote.replacementHistory) {
				if (!isRecord(item)) {
					addReason(reasons, "unsupported-provider-replay");
					break;
				}
				const itemShape = shape(item, reasons);
				if (!itemShape) break;
				replacementShapes.push(itemShape);
			}
			const v2 = remote.version === "v2";
			const item = isRecord(remote.compactionItem) ? remote.compactionItem : undefined;
			const compactionItemKind = item?.type === "compaction" || item?.type === "compaction_summary" ? item.type : item === undefined && v2 ? "absent" : "unknown";
			if (compactionItemKind === "unknown") addReason(reasons, "unsupported-provider-replay");
			const payload = typeof item?.encrypted_content === "string" ? item.encrypted_content : typeof item?.summary === "string" ? item.summary : "";
			result.openaiRemote = { version: v2 ? "v2" : item ? "v1" : "unknown", replacementHistoryCount: remote.replacementHistory.length, replacementShapes, compactionItemKind, compactionItemUtf8Bytes: utf8Bytes(payload), usedTokens: numeric(remote, "usedTokens") };
		}
	}
	const anthropic = value.anthropicCompaction;
	if (anthropic !== undefined) {
		if (!isRecord(anthropic) || typeof anthropic.content !== "string") addReason(reasons, "unsupported-provider-replay");
		else {
			const allowed = { provider: true, content: true, toolChanges: true, signature: true, encryptedContent: true, filesText: true, retainedFiles: true, exactTail: true, model: true, usedTokens: true };
			if (Object.keys(anthropic).some(key => !Object.hasOwn(allowed, key))) addReason(reasons, "unsupported-provider-replay");
			const toolChangeShapes: ScalarShape[] = [];
			if (anthropic.toolChanges !== undefined) {
				if (!Array.isArray(anthropic.toolChanges)) addReason(reasons, "unsupported-provider-replay");
				else for (const change of anthropic.toolChanges) {
					const changeShape = shape(change, reasons);
					if (!changeShape) break;
					toolChangeShapes.push(changeShape);
				}
			}
			const retainedFiles: RetainedFileScalar[] = [];
			if (anthropic.retainedFiles !== undefined) {
				if (!Array.isArray(anthropic.retainedFiles)) addReason(reasons, "unsupported-provider-replay");
				else for (const file of anthropic.retainedFiles) {
					if (!isRecord(file) || typeof file.text !== "string") {
						addReason(reasons, "unsupported-provider-replay");
						break;
					}
					retainedFiles.push({ textUtf8Bytes: utf8Bytes(file.text), afterOffsetMs: offsetNumeric(file, "after", baseTimestamp) });
				}
			}
			result.anthropic = {
				contentUtf8Bytes: utf8Bytes(anthropic.content),
				signatureUtf8Bytes: utf8Bytes(typeof anthropic.signature === "string" ? anthropic.signature : ""),
				encryptedContentUtf8Bytes: utf8Bytes(typeof anthropic.encryptedContent === "string" ? anthropic.encryptedContent : ""),
				filesTextUtf8Bytes: utf8Bytes(typeof anthropic.filesText === "string" ? anthropic.filesText : ""),
				retainedFiles,
				toolChangeShapes,
				exactTail: anthropic.exactTail === true,
				usedTokens: numeric(anthropic, "usedTokens"),
			};
		}
	}
	if (value.snapcompact !== undefined) {
		const archive = archiveDetail(value.snapcompact, reasons);
		if (archive) result.snapcompact = archive;
	}
	return result;
}

function messageDetail(record: JsonRecord, topology: Topology, reasons: Set<IncompleteReason>, baseTimestamp: number) {
	const message = isRecord(record.message) ? record.message : undefined;
	if (!message || topology.role === "unknown") {
		addReason(reasons, "unsupported-message-role");
		return undefined;
	}
	const content = message.content;
	const blocks = { text: 0, thinking: 0, redactedThinking: 0, image: 0, toolCall: 0, fallback: 0, textUtf8Bytes: 0, thinkingUtf8Bytes: 0, imageDataUtf8Bytes: 0 };
	const argumentShapes: ScalarShape[] = [];
	if (typeof content === "string") {
		if (topology.role === "assistant" || topology.role === "toolResult") {
			addReason(reasons, "unsupported-context-message-field");
			return undefined;
		}
		blocks.text = 1;
		blocks.textUtf8Bytes = utf8Bytes(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block) || typeof block.type !== "string") {
				addReason(reasons, "unsupported-message-block");
				return undefined;
			}
			if (topology.role !== "assistant" && block.type !== "text" && block.type !== "image") {
				addReason(reasons, "unsupported-message-block");
				return undefined;
			}
			switch (block.type) {
				case "text":
					if (typeof block.text !== "string") return undefined;
					blocks.text++;
					blocks.textUtf8Bytes += utf8Bytes(block.text);
					break;
				case "thinking":
					if (typeof block.thinking !== "string") return undefined;
					blocks.thinking++;
					blocks.thinkingUtf8Bytes += utf8Bytes(block.thinking);
					break;
				case "redactedThinking":
					if (typeof block.data !== "string") return undefined;
					blocks.redactedThinking++;
					blocks.thinkingUtf8Bytes += utf8Bytes(block.data);
					break;
				case "image":
					if (typeof block.data !== "string" || typeof block.mimeType !== "string") return undefined;
					blocks.image++;
					blocks.imageDataUtf8Bytes += utf8Bytes(block.data);
					break;
				case "toolCall":
					if (!isRecord(block.arguments)) return undefined;
					const argumentShape = shape(block.arguments, reasons);
					if (!argumentShape) return undefined;
					blocks.toolCall++;
					argumentShapes.push(argumentShape);
					break;
				case "fallback":
					blocks.fallback++;
					break;
				default:
					addReason(reasons, "unsupported-message-block");
					return undefined;
			}
		}
	} else {
		addReason(reasons, "unsupported-context-message-field");
		return undefined;
	}
	let detailsShape: ScalarShape | undefined;
	if (topology.role === "toolResult" && message.details !== undefined) {
		detailsShape = shape(message.details, reasons);
		if (!detailsShape) return undefined;
	}
	if (topology.role === "assistant" && message.providerPayload !== undefined) addReason(reasons, "unsupported-message-provider-payload");
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const snapshot = isRecord(message.contextSnapshot) ? message.contextSnapshot : undefined;
	return {
		ordinal: topology.ordinal,
		type: "message",
		role: topology.role,
		messageTimestampOffsetMs:
			topology.messageTimestampMs === null ? null : topology.messageTimestampMs - baseTimestamp,
		stopReason: typeof message.stopReason === "string" && Object.hasOwn(STOP_REASON, message.stopReason) ? message.stopReason : "unknown",
		usage:
			topology.role === "assistant"
				? {
						input: numeric(usage, "input"),
						output: numeric(usage, "output"),
						cacheRead: numeric(usage, "cacheRead"),
						cacheWrite: numeric(usage, "cacheWrite"),
						totalTokens: numeric(usage, "totalTokens"),
						contextTokens: numeric(usage, "contextTokens"),
						orchestrationInput: numeric(isRecord(usage?.orchestration) ? usage.orchestration : undefined, "input"),
						orchestrationOutput: numeric(isRecord(usage?.orchestration) ? usage.orchestration : undefined, "output"),
						orchestrationCacheRead: numeric(isRecord(usage?.orchestration) ? usage.orchestration : undefined, "cacheRead"),
					}
				: undefined,
		contextSnapshot:
			topology.role === "assistant"
				? {
						promptTokens: numeric(snapshot, "promptTokens"),
						nonMessageTokens: numeric(snapshot, "nonMessageTokens"),
						toolSchemaTokens: numeric(snapshot, "toolSchemaTokens"),
						historyRewriteTokensRemoved: numeric(snapshot, "historyRewriteTokensRemoved"),
						compactionEpoch: numeric(snapshot, "compactionEpoch"),
						lastMessageTimestampOffsetMs: offsetNumeric(snapshot, "lastMessageTimestamp", baseTimestamp),
					}
				: undefined,
		rewriteRelations: {
			prunedAtOffsetMs: offsetNumeric(message, "prunedAt", baseTimestamp),
			historyRewriteAtOffsetMs: offsetNumeric(message, "historyRewriteAt", baseTimestamp),
		},
		blocks,
		argumentShapes,
		detailsShape,
		retryRecovery: topology.retryRecovery,
		emptyErrorTurn: topology.emptyErrorTurn,
	};
}

function compactionDetail(record: JsonRecord, topology: Topology, reasons: Set<IncompleteReason>, baseTimestamp: number) {
	if (typeof record.summary !== "string") {
		addReason(reasons, "invalid-session-entry");
		return undefined;
	}
	if (record.details !== undefined && !(isRecord(record.details) && record.details.kind === "experimental-context-rollover")) {
		addReason(reasons, "unsupported-rollover-details");
	}
	return {
		ordinal: topology.ordinal,
		type: "compaction",
		compaction: {
			summaryUtf8Bytes: utf8Bytes(record.summary),
			summaryUtf16Units: record.summary.length,
			shortSummaryUtf8Bytes: utf8Bytes(typeof record.shortSummary === "string" ? record.shortSummary : ""),
			tokensBefore: numeric(record, "tokensBefore"),
			tokensAfter: numeric(record, "tokensAfter"),
			method: record.method === undefined ? "absent" : typeof record.method === "string" && Object.hasOwn(COMPACTION_METHOD, record.method) ? record.method : "unknown",
			firstKeptOrdinal: topology.firstKeptOrdinal,
			providerReplayThroughOrdinal: topology.providerReplayThroughOrdinal,
			preserve: preserveDetail(record.preserveData, reasons, baseTimestamp),
		} satisfies CompactionDetail,
	};
}

function scopedDetail(record: JsonRecord, topology: Topology, reasons: Set<IncompleteReason>, baseTimestamp: number) {
	if (topology.type === "message") return messageDetail(record, topology, reasons, baseTimestamp);
	if (topology.type === "compaction") return compactionDetail(record, topology, reasons, baseTimestamp);
	if (topology.type === "branch_summary") {
		return {
			ordinal: topology.ordinal,
			type: "branch_summary",
			summaryUtf8Bytes: typeof record.summary === "string" ? utf8Bytes(record.summary) : 0,
		};
	}
	if (topology.type === "custom_message") {
		const content = record.content;
		return {
			ordinal: topology.ordinal,
			type: "custom_message",
			customType: topology.customCategory,
			contentUtf8Bytes: typeof content === "string" ? utf8Bytes(content) : 0,
			detailsShape: record.details === undefined ? undefined : shape(record.details, reasons),
		};
	}
	if (topology.customCategory === "context-notes") {
		if (!isRecord(record.data) || record.data.version !== 1 || typeof record.data.text !== "string") {
			addReason(reasons, "unsupported-context-notes");
			return undefined;
		}
		return {
			ordinal: topology.ordinal,
			type: "context_notes",
			textUtf8Bytes: utf8Bytes(record.data.text),
			textUtf16Units: record.data.text.length,
		};
	}
	return { ordinal: topology.ordinal, type: topology.type, physicalBytes: topology.physicalBytes };
}

function aggregateValue(value: unknown, bucket: AggregateBucket, reasons: Set<IncompleteReason>, depth = 0, budget: { nodes: number } = { nodes: 0 }): void {
	budget.nodes++;
	bucket.maximumDepth = Math.max(bucket.maximumDepth, depth);
	if (budget.nodes > MAX_AGGREGATE_NODES) {
		addReason(reasons, "historical-payload-shape-limit");
		return;
	}
	if (typeof value === "string") {
		bucket.stringUtf8Bytes += utf8Bytes(value);
		return;
	}
	if (Array.isArray(value)) {
		bucket.arrayCount++;
		for (const item of value) aggregateValue(item, bucket, reasons, depth + 1, budget);
		return;
	}
	if (isRecord(value)) {
		bucket.objectCount++;
		for (const item of Object.values(value)) aggregateValue(item, bucket, reasons, depth + 1, budget);
	}
}

function aggregateRecord(record: JsonRecord, topology: Topology, buckets: Map<string, AggregateBucket>, reasons: Set<IncompleteReason>): void {
	const typeCode = ENTRY_TYPE_CODE[topology.type]!;
	const roleCode = ROLE_CODE[topology.role]!;
	const key = `${typeCode}:${roleCode}`;
	let bucket = buckets.get(key);
	if (!bucket) {
		bucket = { typeCode, roleCode, rows: 0, physicalBytes: 0, stringUtf8Bytes: 0, imageDataUtf8Bytes: 0, arrayCount: 0, objectCount: 0, maximumDepth: 0 };
		buckets.set(key, bucket);
	}
	bucket.rows++;
	bucket.physicalBytes += topology.physicalBytes;
	aggregateValue(record, bucket, reasons);
	const content = isRecord(record.message) ? record.message.content : record.content;
	if (Array.isArray(content)) for (const block of content) if (isRecord(block) && block.type === "image" && typeof block.data === "string") bucket.imageDataUtf8Bytes += utf8Bytes(block.data);
}

function collectScopedPairs(record: JsonRecord, topology: Topology, calls: Set<string>, results: Set<string>): void {
	const message = isRecord(record.message) ? record.message : undefined;
	if (!message) return;
	if (topology.role === "assistant" && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		}
	}
	if (topology.role === "toolResult" && typeof message.toolCallId === "string") results.add(message.toolCallId);
}

async function scanPrefix(
	journal: string,
	prefixBytes: number,
	onLine: (line: Buffer, physicalBytes: number, endByte: number) => void,
	hash?: Hash,
) {
	const stream = createReadStream(journal, { start: 0, end: prefixBytes - 1, highWaterMark: 64 * 1024 });
	let chunks: Buffer[] = [];
	let lineBytes = 0;
	let completedBytes = 0;
	let oversized = false;
	for await (const rawChunk of stream) {
		const chunk = Buffer.from(rawChunk);
		hash?.update(chunk);
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(0x0a, start);
			const end = newline < 0 ? chunk.length : newline;
			const piece = chunk.subarray(start, end);
			if (!oversized) {
				if (lineBytes + piece.length > MAX_PHYSICAL_LINE_BYTES) {
					oversized = true;
					chunks = [];
				} else if (piece.length > 0) chunks.push(piece);
			}
			lineBytes += piece.length;
			if (newline < 0) break;
			const physicalBytes = lineBytes + 1;
			completedBytes += physicalBytes;
			onLine(oversized ? Buffer.alloc(0) : Buffer.concat(chunks, lineBytes), physicalBytes, completedBytes);
			chunks = [];
			lineBytes = 0;
			oversized = false;
			start = newline + 1;
		}
	}
	return { completedBytes, trailingBytes: lineBytes, oversized };
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
	if (prefixBytes !== EXPECTED_PREFIX_BYTES) throw new Error("--prefix-bytes must be the confirmed pre-kill boundary");
	if (descriptorLimitBytes !== DESCRIPTOR_OUTPUT_LIMIT_BYTES) throw new Error("--descriptor-limit-bytes must be 16777216");
	const cutoffMs = Date.parse(cutoff);
	const stat = await fs.stat(journal);
	if (!Number.isFinite(cutoffMs) || stat.size < prefixBytes) throw new Error("journal cannot satisfy the confirmed projection boundary");

	const reasons = new Set<IncompleteReason>();
	const counts: Counts = { physicalRows: 0, validSessionEntries: 0, malformedRows: 0, postCutoffRows: 0, largestPhysicalLineBytes: 0, truncatedTrailingBytes: 0 };
	const entries: Topology[] = [];
	const hash = createHash("sha256");
	const firstScan = await scanPrefix(
		journal,
		prefixBytes,
		(line, physicalBytes) => {
			counts.physicalRows++;
			counts.largestPhysicalLineBytes = Math.max(counts.largestPhysicalLineBytes, physicalBytes);
			if (line.length === 0) {
				counts.malformedRows++;
				addReason(reasons, "line-byte-limit");
				return;
			}
			const source = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
			let record: unknown;
			try {
				record = JSON.parse(source.toString("utf8"));
			} catch {
				counts.malformedRows++;
				addReason(reasons, "malformed-json");
				return;
			}
			if (!isRecord(record)) {
				counts.malformedRows++;
				addReason(reasons, "invalid-session-entry");
				return;
			}
			if (record.type === "session") return;
			if (typeof record.timestamp !== "string" || Date.parse(record.timestamp) > cutoffMs) {
				counts.postCutoffRows++;
				addReason(reasons, "post-cutoff-before-boundary");
				return;
			}
			const base = baseEntry(record);
			if (!base) {
				counts.malformedRows++;
				addReason(reasons, knownEntryType(record.type) ? "invalid-session-entry" : "unknown-entry-type");
				return;
			}
			counts.validSessionEntries++;
			entries.push(topologyFor(record, base, counts.validSessionEntries, physicalBytes, reasons));
		},
		hash,
	);
	if (firstScan.trailingBytes > 0 || firstScan.oversized || firstScan.completedBytes !== prefixBytes) {
		counts.truncatedTrailingBytes = firstScan.trailingBytes;
		addReason(reasons, "truncated-prefix-line");
	}
	const prefixHash = hash.digest("hex");
	const bySourceId = resolveTopology(entries, reasons);
	const leafOrdinal = resolveLeaf(entries, bySourceId);
	const branch = branchFor(leafOrdinal, entries, reasons);
	const projection = scopeAndContext(branch, entries, reasons);
	const baseTimestamp = entries.reduce(
		(minimum, entry) => Math.min(minimum, entry.timestampMs),
		Number.POSITIVE_INFINITY,
	);
	const scopeAllowed = !reasons.has("scope-entry-limit");
	const scopedEntries: object[] = [];
	const historicalBuckets = new Map<string, AggregateBucket>();
	const scopedToolCalls = new Set<string>();
	const scopedToolResults = new Set<string>();
	if (scopeAllowed) {
		let ordinal = 0;
		const secondScan = await scanPrefix(journal, prefixBytes, (line, _physicalBytes) => {
			if (line.length === 0) return;
			const source = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
			let record: unknown;
			try {
				record = JSON.parse(source.toString("utf8"));
			} catch {
				return;
			}
			if (!isRecord(record) || record.type === "session") return;
			const base = baseEntry(record);
			if (!base || Date.parse(record.timestamp as string) > cutoffMs) return;
			ordinal++;
			const topology = entries[ordinal - 1];
			if (!topology || topology.sourceId !== base.sourceId) {
				addReason(reasons, "projection-desync");
				return;
			}
			if (projection.scope.has(ordinal)) {
				collectScopedPairs(record, topology, scopedToolCalls, scopedToolResults);
				const detail = scopedDetail(record, topology, reasons, baseTimestamp);
				if (detail) scopedEntries.push(detail);
			} else {
				aggregateRecord(record, topology, historicalBuckets, reasons);
			}
		});
		if (secondScan.trailingBytes > 0 || secondScan.oversized || secondScan.completedBytes !== prefixBytes) addReason(reasons, "truncated-prefix-line");
	}
	const topology = entries.map(entry => [
		entry.ordinal,
		entry.parentOrdinal ?? -1,
		entry.activeLeafState,
		entry.activeLeafOrdinal ?? 0,
		ENTRY_TYPE_CODE[entry.type]!,
		ROLE_CODE[entry.role]!,
		entry.timestampMs - baseTimestamp,
		entry.physicalBytes,
		(entry.anchorEligible ? 1 : 0) | (entry.retryRecovery ? 2 : 0) | (entry.emptyErrorTurn ? 4 : 0) | (entry.customCategory === "context-notes" ? 8 : 0) | (entry.isRolloverRequest ? 16 : 0) | (entry.hasSummary ? 32 : 0),
	]);
	const byOrdinal = new Map(entries.map(entry => [entry.ordinal, entry]));
	const compactionIndex = projection.latestCompactionOrdinal === null ? -1 : branch.indexOf(projection.latestCompactionOrdinal);
	let latestAnchorOrdinal: number | null = null;
	for (let index = branch.length - 1; index > compactionIndex; index--) {
		const entry = byOrdinal.get(branch[index]!);
		if (entry?.anchorEligible) {
			latestAnchorOrdinal = entry.ordinal;
			break;
		}
	}
	const anchorTimestamp = latestAnchorOrdinal === null ? null : byOrdinal.get(latestAnchorOrdinal)?.messageTimestampMs ?? null;
	const projectedActiveIndex = latestAnchorOrdinal === null ? -1 : projection.activeItems.findIndex(item => item.kind === "source" && item.ordinal === latestAnchorOrdinal);
	const timestampMatchCount = anchorTimestamp === null ? 0 : projection.activeItems.filter(item => item.kind === "source" && byOrdinal.get(item.ordinal)?.messageTimestampMs === anchorTimestamp).length;
	let danglingToolCallCount: number | "unavailable" = "unavailable";
	if (scopeAllowed) {
		danglingToolCallCount = 0;
		for (const call of scopedToolCalls) if (!scopedToolResults.has(call)) danglingToolCallCount++;
	}
	const terminal = {
		lastSelectedRole: leafOrdinal === null ? "non-message" : byOrdinal.get(leafOrdinal)?.role ?? "non-message",
		danglingToolCallCount,
	};
	const receipt = {
		schemaVersion: 2,
		outcome: reasons.size === 0 ? "complete" : "incomplete",
		prefix: { prefixBytes, prefixHash, fileBytesAtRead: stat.size, physicalRecordCount: counts.physicalRows, validSessionEntryCount: counts.validSessionEntries, selectedPreKillByteBoundary: prefixBytes, malformedRowCount: counts.malformedRows, postCutoffRowCount: counts.postCutoffRows, largestPhysicalLineBytes: counts.largestPhysicalLineBytes, truncatedTrailingBytes: counts.truncatedTrailingBytes },
		bounds: { descriptorOutputLimitBytes: descriptorLimitBytes, maximumPhysicalLineBytes: MAX_PHYSICAL_LINE_BYTES, maximumScopedEntries: MAX_SCOPED_ENTRIES, selectedScopeEntries: projection.scope.size },
		codebook: { entryType: ENTRY_TYPE_CODE, role: ROLE_CODE, activeLeafState: { absent: 0, null: 1, ordinal: 2, dangling: 3 }, topologyFlags: { anchorEligible: 1, retryRecovery: 2, emptyErrorTurn: 4, contextNotes: 8, rolloverRequest: 16, branchSummary: 32 } },
		topology,
		replay: { resolvedLeafOrdinal: leafOrdinal, branchEntryOrdinals: branch, branchEntryCount: branch.length, latestCompactionOrdinal: projection.latestCompactionOrdinal, latestResetBoundaryOrdinal: projection.latestResetBoundaryOrdinal, resetBoundaryRelation: projection.resetBoundaryRelation, providerReplayMode: projection.providerReplayMode, notesEntryOrdinal: projection.notesEntryOrdinal },
		activeContext: { items: projection.activeItems, messageCount: projection.activeItems.length },
		anchor: { latestEligibleBranchAnchorOrdinal: latestAnchorOrdinal, projectedActiveIndex, timestampMatchCount, pendingSnapshot: "fresh-session-absent", compactionEpoch: 0, accountingBranch: latestAnchorOrdinal !== null && projectedActiveIndex >= 0 ? "provider-anchor-candidate" : "unanchored-active-count" },
		terminal,
		scopedEntries,
		historicalAggregates: [...historicalBuckets.values()],
		incompleteReasons: [...reasons],
	};
	if (utf8Bytes(JSON.stringify(receipt)) > descriptorLimitBytes) {
		addReason(reasons, "output-limit");
		await writeReceipt(output, { schemaVersion: 2, outcome: "incomplete", prefix: receipt.prefix, bounds: receipt.bounds, incompleteReasons: [...reasons] });
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
