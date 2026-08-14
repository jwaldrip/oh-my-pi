/**
 * Render one ACP `session/update` payload (the `update` field of a `ServerFrame`)
 * as a single display line for the client TUI's transcript.
 *
 * Deliberately a summary, not a re-implementation of `acp-event-mapper.ts`'s
 * rich renderer: this mode's job is to prove the daemon-attach lifecycle
 * (switch without spawning, survive a kill, replay on reattach), not to
 * reproduce interactive-mode's full transcript fidelity. Unknown or malformed
 * payloads fall back to a compact JSON preview rather than being dropped, so a
 * daemon speaking a newer ACP vocabulary never renders as silence.
 */

interface TextContentBlock {
	type: "text";
	text: string;
}

function isTextBlock(value: unknown): value is TextContentBlock {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || !("text" in value)) return false;
	return value.type === "text" && typeof value.text === "string";
}

function truncate(text: string, max = 400): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}\u2026` : collapsed;
}

function previewJson(value: unknown, max = 200): string {
	try {
		const json = JSON.stringify(value);
		return json.length > max ? `${json.slice(0, max)}\u2026` : json;
	} catch {
		return String(value);
	}
}

/** Reads one field off an ACP update payload once its `object` shape is confirmed by the caller. */
function field(record: object, key: string): unknown {
	return key in record ? (record as Record<string, unknown>)[key] : undefined;
}

export function formatSessionUpdate(update: unknown): string {
	if (typeof update !== "object" || update === null || !("sessionUpdate" in update)) {
		return `[update] ${previewJson(update)}`;
	}
	const kind = update.sessionUpdate;

	switch (kind) {
		case "user_message_chunk":
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const content = field(update, "content");
			const text = isTextBlock(content) ? content.text : previewJson(content);
			const label = kind === "user_message_chunk" ? "you" : kind === "agent_thought_chunk" ? "thinking" : "agent";
			return `${label}: ${truncate(text)}`;
		}
		case "tool_call": {
			const rawTitle = field(update, "title");
			const title = typeof rawTitle === "string" ? rawTitle : String(field(update, "toolCallId") ?? "tool");
			const rawStatus = field(update, "status");
			const status = typeof rawStatus === "string" ? rawStatus : "pending";
			return `tool: ${title} (${status})`;
		}
		case "tool_call_update": {
			const id = String(field(update, "toolCallId") ?? "tool");
			const rawStatus = field(update, "status");
			const status = typeof rawStatus === "string" ? rawStatus : "updated";
			return `tool: ${id} -> ${status}`;
		}
		case "plan": {
			const rawEntries = field(update, "entries");
			const entries = Array.isArray(rawEntries) ? rawEntries.length : 0;
			return `plan: ${entries} step${entries === 1 ? "" : "s"}`;
		}
		case "available_commands_update":
			return "available commands updated";
		default:
			return `[${String(kind)}] ${previewJson(update)}`;
	}
}
