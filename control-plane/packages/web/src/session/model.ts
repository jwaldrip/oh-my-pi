/**
 * The session reducer.
 *
 * An ACP session arrives as an ordered stream of `session/update` payloads. It
 * is not a list of things to print: chunks of one message arrive separately and
 * belong together, and a tool call is announced once and then amended several
 * times under the same id. Turning that stream into something renderable is the
 * only genuinely tricky part of this client, so it lives here, alone, with no
 * DOM anywhere near it.
 *
 * Every function is pure. `reduce` never touches the state it is handed: it
 * returns a new one that shares every entry that did not change, which is what
 * lets the renderer diff by reference and patch a single node per token.
 *
 * Nothing here throws on bad input. A payload this build has never seen becomes
 * an inert row in the timeline. An operator watching an agent run shell commands
 * is owed the truth that something happened, even when we cannot name it.
 */

import type { ApprovalChoice } from "@ompd/core/contracts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** ACP tool kinds we style. Anything else renders under `other`. */
export type ToolKind = "think" | "read" | "execute" | "search" | "edit" | "fetch" | "move" | "delete" | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry {
  content: string;
  priority: string;
  status: PlanStatus;
}

export interface Usage {
  /** Context window tokens consumed. */
  used: number;
  /** Context window size in tokens. */
  size: number;
  costAmount: number;
  costCurrency: string;
}

/**
 * A slash command as advertised by the agent. Names drive the menu order and
 * live on `SessionState.commands`; this record carries the prose that makes the
 * menu usable and is looked up by name.
 */
export interface SlashCommand {
  name: string;
  description: string;
  hint: string | null;
}

export interface Approval {
  requestId: string;
  tool: string;
  title: string;
  input: unknown;
}

/** Whatever the session has told us about itself. All of it optional. */
export interface SessionInfo {
  updatedAt: string | null;
  title: string | null;
  model: string | null;
  cwd: string | null;
}

/** Counts the board shows. Maintained here so no view has to walk the timeline. */
export interface Activity {
  tools: number;
  running: number;
  failed: number;
}

export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantEntry {
  kind: "assistant";
  id: string;
  text: string;
  streaming: boolean;
  /** Reasoning rather than reply. Rendered quieter, and never spoken aloud. */
  thought: boolean;
}

export interface ToolEntry {
  kind: "tool";
  id: string;
  toolKind: ToolKind;
  title: string;
  status: ToolStatus;
  input: unknown;
  output: string | null;
  /** Files the call touched, as ACP reports them. */
  locations: string[];
}

export interface ApprovalEntry {
  kind: "approval";
  id: string;
  requestId: string;
  tool: string;
  title: string;
  input: unknown;
  /** Null until this device, or another one, settles it. */
  decision: ApprovalChoice | null;
}

export interface UnknownEntry {
  kind: "unknown";
  id: string;
  label: string;
  payload: unknown;
}

export type Entry = UserEntry | AssistantEntry | ToolEntry | ApprovalEntry | UnknownEntry;

export interface SessionState {
  readonly entries: readonly Entry[];
  readonly plan: readonly PlanEntry[];
  readonly usage: Usage | null;
  /** Command names, in the order the agent advertised them. */
  readonly commands: readonly string[];
  /** Prose for each name in `commands`, for the menu. Keyed by name. */
  readonly commandDetails: ReadonlyMap<string, SlashCommand>;
  readonly pendingApprovals: readonly Approval[];
  readonly info: SessionInfo;
  readonly activity: Activity;
  /** Source of generated entry ids. Kept in state so reduction is deterministic. */
  readonly ordinal: number;
}

const EMPTY_INFO: SessionInfo = { updatedAt: null, title: null, model: null, cwd: null };
const EMPTY_ACTIVITY: Activity = { tools: 0, running: 0, failed: 0 };

export const EMPTY_SESSION: SessionState = {
  entries: [],
  plan: [],
  usage: null,
  commands: [],
  commandDetails: new Map(),
  pendingApprovals: [],
  info: EMPTY_INFO,
  activity: EMPTY_ACTIVITY,
  ordinal: 0,
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  think: "think",
  read: "read",
  execute: "execute",
  search: "search",
  edit: "edit",
  fetch: "fetch",
  move: "move",
  delete: "delete",
};

const TOOL_STATUSES: Record<string, ToolStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
};

const PLAN_STATUSES: Record<string, PlanStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
};

/** Chunk payloads, mapped to the entry they extend. */
const CHUNK_CHANNELS: Record<string, "user" | "message" | "thought"> = {
  user_message_chunk: "user",
  agent_message_chunk: "message",
  agent_thought_chunk: "thought",
};

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

/**
 * Folds one `session/update` into the state. The returned state is new whenever
 * anything changed and identical by reference when nothing did, so a renderer
 * can skip work by comparing pointers.
 */
export function reduce(state: SessionState, update: unknown): SessionState {
  const payload = unwrap(update);
  const name = readString(payload, "sessionUpdate");
  if (name === null) return appendUnknown(state, "malformed update", update);

  const channel = CHUNK_CHANNELS[name];
  if (channel !== undefined) return reduceChunk(state, payload, channel);

  switch (name) {
    case "tool_call":
      return reduceToolCall(state, payload);
    case "tool_call_update":
      return reduceToolCallUpdate(state, payload);
    case "plan":
      return reducePlan(state, payload);
    case "usage_update":
      return reduceUsage(state, payload);
    case "available_commands_update":
      return reduceCommands(state, payload);
    case "session_info_update":
      return reduceInfo(state, payload);
    case "current_mode_update":
      return reduceMode(state, payload);
    default:
      return appendUnknown(state, name, payload);
  }
}

/** Convenience for replaying a whole transcript, as a resume does. */
export function reduceAll(state: SessionState, updates: readonly unknown[]): SessionState {
  let next = state;
  for (const update of updates) next = reduce(next, update);
  return next;
}

// -- chunks -----------------------------------------------------------------

function reduceChunk(state: SessionState, payload: unknown, channel: "user" | "message" | "thought"): SessionState {
  const text = extractText(readField(payload, "content"));
  if (text.length === 0) return state;

  const messageId = readString(payload, "messageId");
  const thought = channel === "thought";
  const index = findChunkTarget(state.entries, channel, messageId);

  if (index >= 0) {
    const current = state.entries[index];
    if (current === undefined) return state;
    const extended: Entry =
      current.kind === "user"
        ? { ...current, text: current.text + text }
        : { ...(current as AssistantEntry), text: (current as AssistantEntry).text + text };
    return { ...state, entries: replaceAt(state.entries, index, extended) };
  }

  // A new message id ends whatever was still streaming: the agent has moved on.
  const settled = channel === "user" ? state.entries : closeStreams(state.entries);
  const id = messageId ?? `${channel}-${state.ordinal}`;
  const entry: Entry =
    channel === "user"
      ? { kind: "user", id, text }
      : { kind: "assistant", id, text, streaming: true, thought };
  return {
    ...state,
    entries: [...settled, entry],
    ordinal: state.ordinal + 1,
  };
}

/**
 * Where a chunk belongs. An id matches wherever it sits, because an agent may
 * resume a message after a tool call; without one, only a still-open block of
 * the same channel can absorb it.
 */
function findChunkTarget(
  entries: readonly Entry[],
  channel: "user" | "message" | "thought",
  messageId: string | null,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (channel === "user") {
      if (entry.kind !== "user") continue;
      if (messageId !== null) {
        if (entry.id === messageId) return index;
        continue;
      }
      return index;
    }
    if (entry.kind !== "assistant") continue;
    if (entry.thought !== (channel === "thought")) continue;
    if (messageId !== null) {
      if (entry.id === messageId) return index;
      continue;
    }
    if (entry.streaming) return index;
  }
  return -1;
}

function closeStreams(entries: readonly Entry[]): Entry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== "assistant" || !entry.streaming) return entry;
    changed = true;
    return { ...entry, streaming: false };
  });
  return changed ? next : (entries as Entry[]);
}

// -- tools ------------------------------------------------------------------

function reduceToolCall(state: SessionState, payload: unknown): SessionState {
  const toolCallId = readString(payload, "toolCallId");
  if (toolCallId === null) return appendUnknown(state, "tool_call without an id", payload);

  const existing = indexOfTool(state.entries, toolCallId);
  const status = readStatus(payload) ?? "pending";
  const entry: ToolEntry = {
    kind: "tool",
    id: toolCallId,
    toolKind: readToolKind(payload),
    title: readString(payload, "title") ?? toolCallId,
    status,
    input: readField(payload, "rawInput") ?? null,
    output: extractToolOutput(payload),
    locations: readLocations(payload),
  };

  // A repeated announcement amends rather than duplicates. Agents retry.
  if (existing >= 0) {
    const before = state.entries[existing];
    if (before === undefined || before.kind !== "tool") return state;
    return {
      ...state,
      entries: replaceAt(state.entries, existing, entry),
      activity: countActivity(state.activity, before.status, entry.status, false),
    };
  }

  return {
    ...state,
    entries: [...closeStreams(state.entries), entry],
    activity: countActivity(state.activity, null, entry.status, true),
  };
}

function reduceToolCallUpdate(state: SessionState, payload: unknown): SessionState {
  const toolCallId = readString(payload, "toolCallId");
  if (toolCallId === null) return appendUnknown(state, "tool_call_update without an id", payload);

  const index = indexOfTool(state.entries, toolCallId);
  const status = readStatus(payload);
  const output = extractToolOutput(payload);

  // An amendment for a call that was never announced is a protocol gap, not a
  // fifth tool. It is kept as an inert diagnostic so the operator can see that
  // something happened, but it never becomes a card.
  if (index < 0) {
    return appendUnknown(state, `tool_call_update for an unannounced call (${toolCallId})`, payload);
  }

  const before = state.entries[index];
  if (before === undefined || before.kind !== "tool") return state;

  const title = readString(payload, "title");
  const rawInput = readField(payload, "rawInput");
  const locations = readLocations(payload);
  const entry: ToolEntry = {
    kind: "tool",
    id: before.id,
    toolKind: typeof payload === "object" && payload !== null && "kind" in payload ? readToolKind(payload) : before.toolKind,
    title: title ?? before.title,
    status: status ?? before.status,
    input: rawInput === undefined ? before.input : rawInput,
    // Output accumulates: a long command reports progress before it finishes.
    output: output === null ? before.output : output,
    locations: locations.length > 0 ? locations : before.locations,
  };

  return {
    ...state,
    entries: replaceAt(state.entries, index, entry),
    activity: countActivity(state.activity, before.status, entry.status, false),
  };
}

function indexOfTool(entries: readonly Entry[], toolCallId: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.kind === "tool" && entry.id === toolCallId) return index;
  }
  return -1;
}

function countActivity(
  activity: Activity,
  before: ToolStatus | null,
  after: ToolStatus,
  added: boolean,
): Activity {
  const wasRunning = before === "pending" || before === "in_progress";
  const isRunning = after === "pending" || after === "in_progress";
  const wasFailed = before === "failed";
  const isFailed = after === "failed";
  if (!added && wasRunning === isRunning && wasFailed === isFailed) return activity;
  return {
    tools: activity.tools + (added ? 1 : 0),
    running: activity.running + (isRunning ? 1 : 0) - (wasRunning ? 1 : 0),
    failed: activity.failed + (isFailed ? 1 : 0) - (wasFailed ? 1 : 0),
  };
}

// -- panels -----------------------------------------------------------------

function reducePlan(state: SessionState, payload: unknown): SessionState {
  const raw = readField(payload, "entries");
  if (!Array.isArray(raw)) return state;
  const plan: PlanEntry[] = [];
  for (const item of raw) {
    const content = readString(item, "content");
    if (content === null) continue;
    plan.push({
      content,
      priority: readString(item, "priority") ?? "medium",
      status: PLAN_STATUSES[readString(item, "status") ?? ""] ?? "pending",
    });
  }
  return { ...state, plan };
}

function reduceUsage(state: SessionState, payload: unknown): SessionState {
  const used = readNumber(payload, "used");
  const size = readNumber(payload, "size");
  if (used === null && size === null) return state;
  const cost = readField(payload, "cost");
  const previous = state.usage;
  return {
    ...state,
    usage: {
      used: used ?? previous?.used ?? 0,
      size: size ?? previous?.size ?? 0,
      costAmount: readNumber(cost, "amount") ?? previous?.costAmount ?? 0,
      costCurrency: readString(cost, "currency") ?? previous?.costCurrency ?? "USD",
    },
  };
}

function reduceCommands(state: SessionState, payload: unknown): SessionState {
  const raw = readField(payload, "availableCommands");
  if (!Array.isArray(raw)) return state;
  const commands: string[] = [];
  const commandDetails = new Map<string, SlashCommand>();
  for (const item of raw) {
    const name = readString(item, "name");
    if (name === null || commandDetails.has(name)) continue;
    commands.push(name);
    commandDetails.set(name, {
      name,
      description: readString(item, "description") ?? "",
      hint: readString(readField(item, "input"), "hint"),
    });
  }
  return { ...state, commands, commandDetails };
}

function reduceInfo(state: SessionState, payload: unknown): SessionState {
  const info: SessionInfo = {
    updatedAt: readString(payload, "updatedAt") ?? state.info.updatedAt,
    title: readString(payload, "title") ?? state.info.title,
    model: readString(payload, "model") ?? readString(payload, "modelName") ?? state.info.model,
    cwd: readString(payload, "cwd") ?? state.info.cwd,
  };
  return { ...state, info };
}

function reduceMode(state: SessionState, payload: unknown): SessionState {
  const mode = readString(payload, "currentModeId") ?? readString(payload, "modeId");
  if (mode === null) return appendUnknown(state, "current_mode_update", payload);
  return { ...state, info: { ...state.info, model: state.info.model ?? mode } };
}

function appendUnknown(state: SessionState, label: string, payload: unknown): SessionState {
  const entry: UnknownEntry = { kind: "unknown", id: `unknown-${state.ordinal}`, label, payload };
  return { ...state, entries: [...state.entries, entry], ordinal: state.ordinal + 1 };
}

// ---------------------------------------------------------------------------
// Locally originated state
// ---------------------------------------------------------------------------

/**
 * Echoes what the operator just sent. The daemon does not replay a prompt back
 * as an update, and a prompt that leaves no trace on screen reads as a dropped
 * one.
 */
export function appendPrompt(state: SessionState, text: string): SessionState {
  const trimmed = text.trim();
  if (trimmed.length === 0) return state;
  const entry: UserEntry = { kind: "user", id: `prompt-${state.ordinal}`, text: trimmed };
  return {
    ...state,
    entries: [...closeStreams(state.entries), entry],
    ordinal: state.ordinal + 1,
  };
}

/** A clearance request, placed in the timeline where it interrupted the work. */
export function appendApproval(state: SessionState, approval: Approval): SessionState {
  const existing = state.pendingApprovals.some((pending) => pending.requestId === approval.requestId);
  if (existing) return state;
  const entry: ApprovalEntry = {
    kind: "approval",
    id: `approval-${approval.requestId}`,
    requestId: approval.requestId,
    tool: approval.tool,
    title: approval.title,
    input: approval.input,
    decision: null,
  };
  return {
    ...state,
    entries: [...closeStreams(state.entries), entry],
    pendingApprovals: [...state.pendingApprovals, approval],
    ordinal: state.ordinal + 1,
  };
}

/** Settles a clearance. The card stays, showing what was decided. */
export function resolveApproval(state: SessionState, requestId: string, decision: ApprovalChoice): SessionState {
  const index = state.entries.findIndex((entry) => entry.kind === "approval" && entry.requestId === requestId);
  const pending = state.pendingApprovals.filter((approval) => approval.requestId !== requestId);
  if (index < 0) {
    if (pending.length === state.pendingApprovals.length) return state;
    return { ...state, pendingApprovals: pending };
  }
  const before = state.entries[index];
  if (before === undefined || before.kind !== "approval") return state;
  return {
    ...state,
    entries: replaceAt(state.entries, index, { ...before, decision }),
    pendingApprovals: pending,
  };
}

/** The turn ended. Nothing is streaming any more, whatever the last chunk said. */
export function endTurn(state: SessionState): SessionState {
  const entries = closeStreams(state.entries);
  if (entries === state.entries) return state;
  return { ...state, entries };
}

// ---------------------------------------------------------------------------
// Reading untyped wire data
// ---------------------------------------------------------------------------

/**
 * The daemon forwards ACP's `session/update` verbatim, but a notification is
 * sometimes passed through with the interesting object nested one level down.
 * Accept both rather than showing an empty transcript over a field name.
 */
function unwrap(update: unknown): unknown {
  if (typeof update !== "object" || update === null) return update;
  if (hasField(update, "sessionUpdate")) return update;
  const inner = readField(update, "update");
  if (typeof inner === "object" && inner !== null) return inner;
  const params = readField(update, "params");
  if (typeof params === "object" && params !== null) return unwrap(params);
  return update;
}

function hasField(source: unknown, key: string): boolean {
  return typeof source === "object" && source !== null && key in source;
}

function readField(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return Reflect.get(source, key);
}

function readString(source: unknown, key: string): string | null {
  const value = readField(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  const value = readField(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readToolKind(payload: unknown): ToolKind {
  const raw = readString(payload, "kind");
  if (raw === null) return "other";
  return TOOL_KINDS[raw] ?? "other";
}

function readStatus(payload: unknown): ToolStatus | null {
  const raw = readString(payload, "status");
  if (raw === null) return null;
  return TOOL_STATUSES[raw] ?? null;
}

function readLocations(payload: unknown): string[] {
  const raw = readField(payload, "locations");
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const item of raw) {
    const path = readString(item, "path");
    if (path !== null) paths.push(path);
  }
  return paths;
}

/**
 * Tool output arrives in two places at once: `rawOutput.content` and a parallel
 * `content` array of ACP content blocks. They carry the same text, so prefer the
 * structured one and fall back rather than printing both.
 */
function extractToolOutput(payload: unknown): string | null {
  const raw = readField(payload, "rawOutput");
  const fromRaw = extractText(readField(raw, "content"));
  if (fromRaw.length > 0) return fromRaw;
  const fromBlocks = extractText(readField(payload, "content"));
  if (fromBlocks.length > 0) return fromBlocks;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

/** Flattens an ACP content block, a list of them, or a bare string, to text. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = extractText(item);
      if (text.length > 0) parts.push(text);
    }
    return parts.join("");
  }
  if (typeof content !== "object" || content === null) return "";
  const type = readString(content, "type");
  if (type === "content") return extractText(readField(content, "content"));
  const text = readField(content, "text");
  if (typeof text === "string") return text;
  return "";
}

function replaceAt(entries: readonly Entry[], index: number, entry: Entry): Entry[] {
  const next = entries.slice();
  next[index] = entry;
  return next;
}
