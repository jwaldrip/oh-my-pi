import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export const INCIDENT_FIXTURE_BYTES = 167_772_160;
export const INCIDENT_FIXTURE_ENTRIES = 26_800;
export const INCIDENT_FIXTURE_LARGE_WRITE_COUNT = 4;
export const INCIDENT_FIXTURE_LARGE_HTML_BYTES = 2 * 1024 * 1024;
export const INCIDENT_FIXTURE_MAX_ORDINARY_RECORD_BYTES = 128 * 1024;
export const INCIDENT_FIXTURE_SESSION_ID = "incident-memory-attribution";
export const INCIDENT_FIXTURE_LINKED_TAIL_ID = `incident-entry-${INCIDENT_FIXTURE_ENTRIES}`;

// A fixed, valid one-pixel PNG. It is intentionally not synthetic random base64.
export const INCIDENT_FIXTURE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLx8QAAAABJRU5ErkJggg==";

const SYNTHETIC_TIMESTAMP = "2026-10-23T00:00:00.000Z";
const PAIR_COUNT = INCIDENT_FIXTURE_ENTRIES / 2;
const LARGE_WRITE_PAIRS = new Set([0, Math.floor(PAIR_COUNT / 3), Math.floor((PAIR_COUNT * 2) / 3), PAIR_COUNT - 1]);

if (PAIR_COUNT * 2 !== INCIDENT_FIXTURE_ENTRIES || LARGE_WRITE_PAIRS.size !== INCIDENT_FIXTURE_LARGE_WRITE_COUNT) {
	throw new Error("incident fixture constants do not form four distinct linked write pairs");
}

export interface IncidentFixturePayloadBytes {
	readonly historicalHtml: number;
	readonly ordinaryCallArguments: number;
	readonly ordinaryResultText: number;
	readonly ordinaryDetails: number;
	readonly imageData: number;
}

type MutableIncidentFixturePayloadBytes = {
	historicalHtml: number;
	ordinaryCallArguments: number;
	ordinaryResultText: number;
	ordinaryDetails: number;
	imageData: number;
};

export interface IncidentFixtureReceipt {
	readonly schemaVersion: 1;
	readonly file: string;
	readonly checksum: string;
	readonly sourceBytes: number;
	readonly entryCount: number;
	readonly linkedTailId: string;
	readonly largestRecordBytes: number;
	readonly ordinaryRecordMaxBytes: number;
	readonly largeWriteRecordCount: number;
	readonly payloadBytes: IncidentFixturePayloadBytes;
	readonly largeWriteArgumentHashes: Readonly<Record<string, string>>;
	readonly selectedResultTextHashes: Readonly<Record<string, string>>;
	readonly selectedDetailsHashes: Readonly<Record<string, string>>;
	readonly imageHash: string;
}

export interface IncidentFixtureVerification {
	readonly checksum: string;
	readonly sourceBytes: number;
	readonly entryCount: number;
	readonly linkedTailId: string;
	readonly largestRecordBytes: number;
	readonly ordinaryRecordMaxBytes: number;
	readonly largeWriteRecordCount: number;
	readonly payloadBytes: IncidentFixturePayloadBytes;
	readonly largeWriteArgumentHashes: Readonly<Record<string, string>>;
	readonly selectedResultTextHashes: Readonly<Record<string, string>>;
	readonly selectedDetailsHashes: Readonly<Record<string, string>>;
	readonly imageHash: string;
}

type JsonRecord = Record<string, unknown>;

type EntryRecord = {
	readonly line: string;
	readonly historicalHtmlBytes?: number;
	readonly ordinaryCallArgumentBytes?: number;
	readonly ordinaryResultTextBytes?: number;
	readonly ordinaryDetailsBytes?: number;
	readonly imageDataBytes?: number;
	readonly resultText?: string;
	readonly detailsText?: string;
};

function stringField(value: JsonRecord, field: string): string | undefined {
	const candidate = value[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function asciiBytes(bytes: number, seed: number): string {
	if (bytes < 0) throw new Error(`fixture requested negative ASCII byte length: ${bytes}`);
	if (bytes === 0) return "";
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const chars = new Array<string>(bytes);
	let value = (seed | 0) ^ 0x9e3779b9;
	for (let index = 0; index < bytes; index++) {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		chars[index] = alphabet.charAt((value >>> 0) % alphabet.length);
	}
	return chars.join("");
}

function digest(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function checksum(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

function usage(): JsonRecord {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function entryFields(entryIndex: number): JsonRecord {
	return {
		id: `incident-entry-${entryIndex}`,
		parentId: entryIndex === 1 ? null : `incident-entry-${entryIndex - 1}`,
		timestamp: SYNTHETIC_TIMESTAMP,
	};
}

function callId(pair: number): string {
	return `incident-call-${pair + 1}`;
}

function largeHtml(pair: number): string {
	const start = `<!doctype html>\n<html lang="en">\n<body data-note="ordinary &quot;escaped&quot; attribute ${pair}">\n<h1>Incident fixture ${pair}</h1>\n<p>Unicode: München, 東京, café.</p>\n<img alt="deterministic image" src="data:image/png;base64,${INCIDENT_FIXTURE_PNG_BASE64}">\n<section data-lines="one&#10;two">`;
	const end = "</section>\n</body>\n</html>";
	const fixedBytes = byteLength(start) + byteLength(end);
	if (fixedBytes > INCIDENT_FIXTURE_LARGE_HTML_BYTES) {
		throw new Error("incident fixture HTML prefix exceeds the fixed large-write budget");
	}
	const html = `${start}${asciiBytes(INCIDENT_FIXTURE_LARGE_HTML_BYTES - fixedBytes, pair + 1)}${end}`;
	if (byteLength(html) !== INCIDENT_FIXTURE_LARGE_HTML_BYTES) {
		throw new Error("incident fixture historical HTML did not meet its byte budget");
	}
	return html;
}

function lineFor(value: JsonRecord): string {
	return `${JSON.stringify(value)}\n`;
}

function ordinaryCallEntry(entryIndex: number, pair: number, targetBytes: number): EntryRecord {
	const contentPrefix = `ordinary write ${pair + 1}\n`;
	const argumentsValue = {
		path: `history/ordinary-${pair + 1}.txt`,
		content: contentPrefix,
		intent: `fixture-${pair + 1}`,
	};
	const record: JsonRecord = {
		type: "message",
		...entryFields(entryIndex),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId(pair), name: "write", arguments: argumentsValue }],
			api: "openai-responses",
			provider: "openai",
			model: "incident-loopback",
			usage: usage(),
			stopReason: "toolUse",
			timestamp: entryIndex,
		},
	};
	const withoutFiller = byteLength(lineFor(record));
	const fillerBytes = targetBytes - withoutFiller;
	if (fillerBytes < 0) throw new Error(`ordinary call ${pair} exceeds its record budget`);
	argumentsValue.content = `${contentPrefix}${asciiBytes(fillerBytes, entryIndex)}`;
	const line = lineFor(record);
	if (byteLength(line) !== targetBytes) throw new Error(`ordinary call ${pair} did not meet its record budget`);
	return { line, ordinaryCallArgumentBytes: byteLength(argumentsValue.content) };
}

function imageDetails(pair: number): { details: JsonRecord; imageDataBytes: number } {
	const image = { type: "image", data: INCIDENT_FIXTURE_PNG_BASE64, mimeType: "image/png" };
	const slot = pair % 3;
	if (slot === 1) return { details: { images: [image] }, imageDataBytes: byteLength(INCIDENT_FIXTURE_PNG_BASE64) };
	if (slot === 2) {
		return {
			details: { xdev: { inner: { images: [image] } } },
			imageDataBytes: byteLength(INCIDENT_FIXTURE_PNG_BASE64),
		};
	}
	return { details: {}, imageDataBytes: 0 };
}

function ordinaryResultEntry(entryIndex: number, pair: number, targetBytes: number): EntryRecord {
	const resultPrefix = `ordinary result ${pair + 1}\n`;
	const detailsPrefix = `ordinary details ${pair + 1}\n`;
	const image = { type: "image", data: INCIDENT_FIXTURE_PNG_BASE64, mimeType: "image/png" };
	const imageSlot = imageDetails(pair);
	const details: JsonRecord & { payload: string } = {
		marker: `details-${pair + 1}`,
		payload: detailsPrefix,
		...imageSlot.details,
	};
	const textBlock = { type: "text", text: resultPrefix };
	const content: JsonRecord[] = [textBlock];
	if (pair % 3 === 0) content.push(image);
	const record: JsonRecord = {
		type: "message",
		...entryFields(entryIndex),
		message: {
			role: "toolResult",
			toolCallId: callId(pair),
			toolName: "write",
			content,
			details,
			isError: false,
			timestamp: entryIndex,
		},
	};
	const withoutFiller = byteLength(lineFor(record));
	const fillerBytes = targetBytes - withoutFiller;
	if (fillerBytes < 0) throw new Error(`ordinary result ${pair} exceeds its record budget`);
	const resultBytes = Math.floor(fillerBytes / 2);
	const detailsBytes = fillerBytes - resultBytes;
	textBlock.text = `${resultPrefix}${asciiBytes(resultBytes, entryIndex)}`;
	details.payload = `${detailsPrefix}${asciiBytes(detailsBytes, entryIndex + PAIR_COUNT)}`;
	const line = lineFor(record);
	if (byteLength(line) !== targetBytes) throw new Error(`ordinary result ${pair} did not meet its record budget`);
	return {
		line,
		ordinaryResultTextBytes: byteLength(textBlock.text),
		ordinaryDetailsBytes: byteLength(details.payload),
		imageDataBytes: imageSlot.imageDataBytes + (pair % 3 === 0 ? byteLength(INCIDENT_FIXTURE_PNG_BASE64) : 0),
		resultText: textBlock.text,
		detailsText: details.payload,
	};
}

function historicalCallEntry(entryIndex: number, pair: number): EntryRecord {
	const content = largeHtml(pair);
	const record: JsonRecord = {
		type: "message",
		...entryFields(entryIndex),
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId(pair),
					name: "write",
					arguments: { path: `history/large-${pair + 1}.html`, content },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "incident-loopback",
			usage: usage(),
			stopReason: "toolUse",
			timestamp: entryIndex,
		},
	};
	return { line: lineFor(record), historicalHtmlBytes: byteLength(content) };
}

function headerLine(cwd: string): string {
	return lineFor({
		type: "session",
		version: 3,
		id: INCIDENT_FIXTURE_SESSION_ID,
		timestamp: SYNTHETIC_TIMESTAMP,
		cwd,
	});
}

async function writeAll(handle: fs.FileHandle, line: string): Promise<void> {
	const bytes = Buffer.from(line);
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (result.bytesWritten <= 0) throw new Error("incident fixture write made no progress");
		offset += result.bytesWritten;
	}
}

function emptyPayloadBytes(): MutableIncidentFixturePayloadBytes {
	return { historicalHtml: 0, ordinaryCallArguments: 0, ordinaryResultText: 0, ordinaryDetails: 0, imageData: 0 };
}

function addEntryPayloadBytes(target: MutableIncidentFixturePayloadBytes, entry: EntryRecord): void {
	target.historicalHtml += entry.historicalHtmlBytes ?? 0;
	target.ordinaryCallArguments += entry.ordinaryCallArgumentBytes ?? 0;
	target.ordinaryResultText += entry.ordinaryResultTextBytes ?? 0;
	target.ordinaryDetails += entry.ordinaryDetailsBytes ?? 0;
	target.imageData += entry.imageDataBytes ?? 0;
}

function fixedHistoricalRecordBytes(): number {
	let total = 0;
	for (const pair of LARGE_WRITE_PAIRS) total += byteLength(historicalCallEntry(pair * 2 + 1, pair).line);
	return total;
}

function incidentFixtureNormalRecordBudget(cwd: string): { readonly base: number; readonly remainder: number } {
	const reserved = byteLength(headerLine(cwd)) + fixedHistoricalRecordBytes();
	const normalCount = INCIDENT_FIXTURE_ENTRIES - INCIDENT_FIXTURE_LARGE_WRITE_COUNT;
	const normalBytes = INCIDENT_FIXTURE_BYTES - reserved;
	if (normalBytes <= 0) throw new Error("incident fixture has no ordinary-record byte budget");
	const base = Math.floor(normalBytes / normalCount);
	const remainder = normalBytes % normalCount;
	if (base >= INCIDENT_FIXTURE_MAX_ORDINARY_RECORD_BYTES) {
		throw new Error("incident fixture ordinary records would exceed the normal-record cap");
	}
	return { base, remainder };
}

function requiredValue(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
	return value;
}

function readImageData(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.images)) return undefined;
	for (const image of value.images) {
		if (isRecord(image)) {
			const data = stringField(image, "data");
			if (data !== undefined) return data;
		}
	}
	return undefined;
}

function resultImageData(message: JsonRecord): string[] {
	const values: string[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (isRecord(block) && block.type === "image") {
				const data = stringField(block, "data");
				if (data !== undefined) values.push(data);
			}
		}
	}
	const details = message.details;
	const direct = readImageData(details);
	if (direct !== undefined) values.push(direct);
	if (isRecord(details) && isRecord(details.xdev)) {
		const nested = readImageData(details.xdev.inner);
		if (nested !== undefined) values.push(nested);
	}
	return values;
}

/**
 * Builds the full incident-shape fixture incrementally. The caller must invoke
 * this before launching the measured probe process.
 */
export async function prepareIncidentMemoryFixture(file: string, cwd: string): Promise<IncidentFixtureReceipt> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const handle = await fs.open(file, "w");
	const payloadBytes = emptyPayloadBytes();
	const largeWriteArgumentHashes: Record<string, string> = {};
	const selectedResultTextHashes: Record<string, string> = {};
	const selectedDetailsHashes: Record<string, string> = {};
	let largestRecordBytes = 0;
	let ordinaryRecordMaxBytes = 0;
	let sourceBytes = 0;
	let normalRecordIndex = 0;
	let entryCount = 0;
	let tailId = "";
	try {
		const header = headerLine(cwd);
		await writeAll(handle, header);
		sourceBytes += byteLength(header);
		const budget = incidentFixtureNormalRecordBudget(cwd);
		for (let pair = 0; pair < PAIR_COUNT; pair++) {
			const callEntryIndex = entryCount + 1;
			const call = LARGE_WRITE_PAIRS.has(pair)
				? historicalCallEntry(callEntryIndex, pair)
				: ordinaryCallEntry(callEntryIndex, pair, budget.base + (normalRecordIndex++ < budget.remainder ? 1 : 0));
			const callBytes = byteLength(call.line);
			await writeAll(handle, call.line);
			sourceBytes += callBytes;
			largestRecordBytes = Math.max(largestRecordBytes, callBytes);
			if (!LARGE_WRITE_PAIRS.has(pair)) ordinaryRecordMaxBytes = Math.max(ordinaryRecordMaxBytes, callBytes);
			addEntryPayloadBytes(payloadBytes, call);
			if (call.historicalHtmlBytes !== undefined) {
				largeWriteArgumentHashes[callId(pair)] = digest(largeHtml(pair));
			}
			entryCount++;
			tailId = `incident-entry-${entryCount}`;

			const resultEntryIndex = entryCount + 1;
			const result = ordinaryResultEntry(
				resultEntryIndex,
				pair,
				budget.base + (normalRecordIndex++ < budget.remainder ? 1 : 0),
			);
			const resultBytes = byteLength(result.line);
			await writeAll(handle, result.line);
			sourceBytes += resultBytes;
			largestRecordBytes = Math.max(largestRecordBytes, resultBytes);
			ordinaryRecordMaxBytes = Math.max(ordinaryRecordMaxBytes, resultBytes);
			addEntryPayloadBytes(payloadBytes, result);
			if (pair === 1 || pair === Math.floor(PAIR_COUNT / 2)) {
				if (result.resultText === undefined || result.detailsText === undefined) {
					throw new Error(`fixture result ${pair} did not retain its selected verification payload`);
				}
				selectedResultTextHashes[callId(pair)] = digest(result.resultText);
				selectedDetailsHashes[callId(pair)] = digest(result.detailsText);
			}
			entryCount++;
			tailId = `incident-entry-${entryCount}`;
		}
	} finally {
		await handle.close();
	}
	if (entryCount !== INCIDENT_FIXTURE_ENTRIES)
		throw new Error(`fixture generated ${entryCount} entries, expected ${INCIDENT_FIXTURE_ENTRIES}`);
	if (tailId !== INCIDENT_FIXTURE_LINKED_TAIL_ID)
		throw new Error(`fixture linked tail ${tailId} does not match ${INCIDENT_FIXTURE_LINKED_TAIL_ID}`);
	if (sourceBytes !== INCIDENT_FIXTURE_BYTES) {
		throw new Error(`fixture generated ${sourceBytes} bytes, expected ${INCIDENT_FIXTURE_BYTES}`);
	}
	if (ordinaryRecordMaxBytes >= INCIDENT_FIXTURE_MAX_ORDINARY_RECORD_BYTES) {
		throw new Error("fixture ordinary record exceeded the 128 KiB cap");
	}
	const result = await verifyIncidentMemoryFixture(file);
	if (
		result.sourceBytes !== sourceBytes ||
		result.entryCount !== entryCount ||
		result.ordinaryRecordMaxBytes !== ordinaryRecordMaxBytes ||
		result.largestRecordBytes !== largestRecordBytes
	) {
		throw new Error("fixture verification did not agree with generation accounting");
	}
	return {
		schemaVersion: 1,
		file,
		checksum: result.checksum,
		sourceBytes,
		entryCount,
		linkedTailId: tailId,
		largestRecordBytes,
		ordinaryRecordMaxBytes,
		largeWriteRecordCount: INCIDENT_FIXTURE_LARGE_WRITE_COUNT,
		payloadBytes,
		largeWriteArgumentHashes,
		selectedResultTextHashes,
		selectedDetailsHashes,
		imageHash: digest(INCIDENT_FIXTURE_PNG_BASE64),
	};
}

/** Stream-reads and validates a prepared fixture without retaining its transcript. */
export async function verifyIncidentMemoryFixture(
	file: string,
	expectedChecksum?: string,
): Promise<IncidentFixtureVerification> {
	const stat = await fs.stat(file);
	if (stat.size !== INCIDENT_FIXTURE_BYTES) {
		throw new Error(`fixture size ${stat.size} does not equal ${INCIDENT_FIXTURE_BYTES}`);
	}
	const actualChecksum = await checksum(file);
	if (expectedChecksum !== undefined && actualChecksum !== expectedChecksum) {
		throw new Error("fixture checksum does not match the required prepared fixture");
	}
	const payloadBytes = emptyPayloadBytes();
	const largeWriteArgumentHashes: Record<string, string> = {};
	const selectedResultTextHashes: Record<string, string> = {};
	const selectedDetailsHashes: Record<string, string> = {};
	const source = createReadStream(file, { encoding: "utf8" });
	const lines = readline.createInterface({ input: source, crlfDelay: Number.POSITIVE_INFINITY });
	let entryCount = 0;
	let expectedParentId: string | null = null;
	let expectedCallId: string | undefined;
	let linkedTailId = "";
	let largestRecordBytes = 0;
	let ordinaryRecordMaxBytes = 0;
	let largeWriteRecordCount = 0;
	let headerSeen = false;
	for await (const line of lines) {
		const recordBytes = byteLength(`${line}\n`);
		const decoded: unknown = JSON.parse(line);
		if (!isRecord(decoded)) throw new Error("fixture line is not an object");
		const record = decoded;
		if (!headerSeen) {
			headerSeen = true;
			if (record.type !== "session" || record.id !== INCIDENT_FIXTURE_SESSION_ID) {
				throw new Error("fixture header is not the expected session header");
			}
			continue;
		}
		entryCount++;
		const expectedId = `incident-entry-${entryCount}`;
		if (record.id !== expectedId || record.parentId !== expectedParentId) {
			throw new Error(`fixture entry ${entryCount} is not linked to its predecessor`);
		}
		expectedParentId = expectedId;
		linkedTailId = expectedId;
		largestRecordBytes = Math.max(largestRecordBytes, recordBytes);
		const message = record.message;
		if (!isRecord(message)) throw new Error(`fixture entry ${entryCount} is missing its message`);
		if (entryCount % 2 === 1) {
			const content = message.content;
			if (message.role !== "assistant" || !Array.isArray(content)) {
				throw new Error(`fixture call entry ${entryCount} has an invalid role or content`);
			}
			const toolCall = content[0];
			if (!isRecord(toolCall)) throw new Error(`fixture call entry ${entryCount} has no tool call`);
			const toolCallId = stringField(toolCall, "id");
			if (toolCall.type !== "toolCall" || toolCall.name !== "write" || toolCallId === undefined) {
				throw new Error(`fixture call entry ${entryCount} is not a write tool call`);
			}
			expectedCallId = toolCallId;
			const argumentsValue = toolCall.arguments;
			if (!isRecord(argumentsValue)) throw new Error(`fixture call entry ${entryCount} has invalid arguments`);
			const argumentContent = stringField(argumentsValue, "content");
			if (argumentContent === undefined)
				throw new Error(`fixture call entry ${entryCount} has no string content argument`);
			if (byteLength(argumentContent) === INCIDENT_FIXTURE_LARGE_HTML_BYTES) {
				largeWriteRecordCount++;
				largeWriteArgumentHashes[toolCallId] = digest(argumentContent);
				payloadBytes.historicalHtml += byteLength(argumentContent);
			} else {
				ordinaryRecordMaxBytes = Math.max(ordinaryRecordMaxBytes, recordBytes);
				payloadBytes.ordinaryCallArguments += byteLength(argumentContent);
			}
		} else {
			const pairedToolCallId = stringField(message, "toolCallId");
			if (pairedToolCallId === undefined) {
				throw new Error(`fixture result entry ${entryCount} has no tool call id`);
			}
			const content = message.content;
			if (message.role !== "toolResult" || pairedToolCallId !== expectedCallId || !Array.isArray(content)) {
				throw new Error(`fixture result entry ${entryCount} does not pair with its preceding call`);
			}
			const textBlock = content[0];
			if (!isRecord(textBlock) || textBlock.type !== "text") {
				throw new Error(`fixture result entry ${entryCount} has no text content`);
			}
			const resultText = stringField(textBlock, "text");
			if (resultText === undefined) throw new Error(`fixture result entry ${entryCount} has no text content`);
			const details = message.details;
			if (!isRecord(details)) throw new Error(`fixture result entry ${entryCount} has no details payload`);
			const detailsPayload = stringField(details, "payload");
			if (detailsPayload === undefined) throw new Error(`fixture result entry ${entryCount} has no details payload`);
			payloadBytes.ordinaryResultText += byteLength(resultText);
			payloadBytes.ordinaryDetails += byteLength(detailsPayload);
			for (const image of resultImageData(message)) {
				if (image !== INCIDENT_FIXTURE_PNG_BASE64)
					throw new Error("fixture result contains a non-deterministic image payload");
				payloadBytes.imageData += byteLength(image);
			}
			const pair = entryCount / 2 - 1;
			if (pair === 1 || pair === Math.floor(PAIR_COUNT / 2)) {
				selectedResultTextHashes[pairedToolCallId] = digest(resultText);
				selectedDetailsHashes[pairedToolCallId] = digest(detailsPayload);
			}
			ordinaryRecordMaxBytes = Math.max(ordinaryRecordMaxBytes, recordBytes);
			expectedCallId = undefined;
		}
	}
	if (!headerSeen) throw new Error("fixture is empty");
	if (entryCount !== INCIDENT_FIXTURE_ENTRIES)
		throw new Error(`fixture has ${entryCount} entries, expected ${INCIDENT_FIXTURE_ENTRIES}`);
	if (linkedTailId !== INCIDENT_FIXTURE_LINKED_TAIL_ID)
		throw new Error("fixture linked tail did not survive validation");
	if (expectedCallId !== undefined) throw new Error("fixture ends with an unpaired tool call");
	if (largeWriteRecordCount !== INCIDENT_FIXTURE_LARGE_WRITE_COUNT) {
		throw new Error(
			`fixture has ${largeWriteRecordCount} large write records, expected ${INCIDENT_FIXTURE_LARGE_WRITE_COUNT}`,
		);
	}
	if (ordinaryRecordMaxBytes >= INCIDENT_FIXTURE_MAX_ORDINARY_RECORD_BYTES) {
		throw new Error("fixture ordinary record exceeded the 128 KiB cap during validation");
	}
	return {
		checksum: actualChecksum,
		sourceBytes: stat.size,
		entryCount,
		linkedTailId,
		largestRecordBytes,
		ordinaryRecordMaxBytes,
		largeWriteRecordCount,
		payloadBytes,
		largeWriteArgumentHashes,
		selectedResultTextHashes,
		selectedDetailsHashes,
		imageHash: digest(INCIDENT_FIXTURE_PNG_BASE64),
	};
}

if (import.meta.main) {
	void (async () => {
		const file = path.resolve(requiredValue("--outfile"));
		const cwd = path.resolve(requiredValue("--cwd"));
		const receipt = await prepareIncidentMemoryFixture(file, cwd);
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
	})().catch(error => {
		process.stderr.write(
			`incident fixture preparation failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
