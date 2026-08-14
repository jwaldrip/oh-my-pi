/**
 * The reducer is the only place that knows how an ACP stream becomes something
 * a person can read, so it is tested against a real captured turn rather than
 * against payloads written to match the implementation.
 *
 * `scripts/update-shapes.json` is a verbatim recording of one turn that planned,
 * read a file, ran a shell command, and answered. Regenerate it with
 * `bun run scripts/capture-updates.ts`.
 *
 * Every test here fails on a bug that would actually be shipped: a token per
 * bubble, a tool card duplicated by its own completion, a plan that accumulates
 * instead of replacing, a payload silently dropped because this build has never
 * seen it, a reducer that scribbles on the state it was handed.
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_SESSION,
  appendApproval,
  appendPrompt,
  endTurn,
  reduce,
  reduceAll,
  resolveApproval,
} from "../src/session/model.ts";
import type { AssistantEntry, SessionState, ToolEntry } from "../src/session/model.ts";

interface Capture {
  counts: Record<string, number>;
  stream: { at: number; kind: string; update: unknown }[];
}

const capture: Capture = await Bun.file(new URL("../../../scripts/update-shapes.json", import.meta.url)).json();
const STREAM = capture.stream.map((frame) => frame.update);

function replay(): SessionState {
  return reduceAll(EMPTY_SESSION, STREAM);
}

function toolsOf(state: SessionState): ToolEntry[] {
  return state.entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
}

function assistantsOf(state: SessionState): AssistantEntry[] {
  return state.entries.filter((entry): entry is AssistantEntry => entry.kind === "assistant");
}

// ---------------------------------------------------------------------------
// The captured turn
// ---------------------------------------------------------------------------

describe("captured turn", () => {
  test("the fixture is the shape these tests claim it is", () => {
    // Guards the tests themselves: a regenerated capture with different counts
    // would otherwise quietly weaken every assertion below.
    expect(capture.counts.agent_message_chunk).toBe(7);
    expect(capture.counts.tool_call).toBe(4);
    expect(capture.counts.tool_call_update).toBe(6);
    expect(capture.counts.plan).toBe(2);
    expect(STREAM.length).toBe(23);
  });

  test("seven chunks coalesce into one message per messageId", () => {
    const state = replay();
    const messages = assistantsOf(state);
    const ids = STREAM.filter(
      (update): update is { sessionUpdate: string; messageId: string } =>
        typeof update === "object" &&
        update !== null &&
        Reflect.get(update, "sessionUpdate") === "agent_message_chunk",
    ).map((update) => update.messageId);
    const distinct = new Set(ids);

    expect(distinct.size).toBe(2);
    expect(messages.length).toBe(distinct.size);
    expect(messages.map((message) => message.id).sort()).toEqual([...distinct].sort());
  });

  test("a coalesced message is the concatenation of its chunks, in order", () => {
    const state = replay();
    const first = assistantsOf(state)[0];
    expect(first).toBeDefined();
    // Four chunks, one of which splits a word across the boundary: "not" + "es.md".
    expect(first?.text.startsWith("`notes.md` contained")).toBe(true);
    expect(first?.text).toContain("hello-from-ompd");
    expect(first?.text.includes("undefined")).toBe(false);
  });

  test("four tool calls become four cards, and six updates mutate rather than append", () => {
    const state = replay();
    const tools = toolsOf(state);

    expect(tools.length).toBe(4);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(4);
    expect(tools.map((tool) => tool.toolKind)).toEqual(["think", "read", "execute", "think"]);
    // Every card ends settled, which only holds if the updates found their card.
    expect(tools.map((tool) => tool.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(state.activity).toEqual({ tools: 4, running: 0, failed: 0 });
  });

  test("a mutated card keeps its announced identity and gains its output", () => {
    const state = replay();
    const execute = toolsOf(state).find((tool) => tool.toolKind === "execute");

    expect(execute?.title).toBe("$ echo hello-from-ompd");
    expect(execute?.status).toBe("completed");
    expect(execute?.output).toContain("hello-from-ompd");
    expect(execute?.input).not.toBeNull();
  });

  test("locations announced with a read survive onto the card", () => {
    const state = replay();
    const read = toolsOf(state).find((tool) => tool.toolKind === "read");
    expect(read?.locations.length).toBe(1);
    expect(read?.locations[0]?.endsWith("notes.md")).toBe(true);
  });

  test("the plan reflects the last plan update, not the sum of both", () => {
    const state = replay();
    expect(state.plan.length).toBe(3);
    expect(state.plan.map((entry) => entry.status)).toEqual(["completed", "completed", "completed"]);
    expect(state.plan[0]?.content).toBe("Read notes.md");
  });

  test("usage parses into a context window and a real cost", () => {
    const state = replay();
    expect(state.usage).toEqual({
      used: 68_406,
      size: 1_000_000,
      costAmount: 1.4408195,
      costCurrency: "USD",
    });
  });

  test("the command list survives with its prose", () => {
    const state = replay();
    expect(state.commands.length).toBe(438);
    expect(state.commands.length).toBe(state.commandDetails.size);
    const model = state.commandDetails.get("model");
    expect(model?.description).toBe("Show current model selection");
    const security = state.commandDetails.get("security");
    expect(security?.hint).toContain("plan");
  });

  test("the replayed turn is entirely renderable: nothing landed in the unknown bucket", () => {
    const state = replay();
    expect(state.entries.filter((entry) => entry.kind === "unknown")).toEqual([]);
  });

  test("replaying the same stream twice produces identical state", () => {
    expect(JSON.stringify(replay().entries)).toBe(JSON.stringify(replay().entries));
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  test("reduce never writes to the state it was given", () => {
    const before = replay();
    const snapshot = JSON.stringify(before.entries);
    const entriesRef = before.entries;
    const planRef = before.plan;

    const after = reduce(before, {
      sessionUpdate: "tool_call_update",
      toolCallId: toolsOf(before)[0]?.id,
      status: "failed",
    });

    expect(before.entries).toBe(entriesRef);
    expect(before.plan).toBe(planRef);
    expect(JSON.stringify(before.entries)).toBe(snapshot);
    expect(after).not.toBe(before);
    expect(toolsOf(after)[0]?.status).toBe("failed");
    expect(toolsOf(before)[0]?.status).toBe("completed");
  });

  test("entries that did not change keep their identity, so the renderer can skip them", () => {
    const before = replay();
    const target = toolsOf(before)[2];
    expect(target).toBeDefined();

    const after = reduce(before, { sessionUpdate: "tool_call_update", toolCallId: target?.id, status: "failed" });

    const changedIndex = before.entries.findIndex((entry) => entry.id === target?.id);
    for (let index = 0; index < before.entries.length; index += 1) {
      if (index === changedIndex) {
        expect(after.entries[index]).not.toBe(before.entries[index]);
        continue;
      }
      expect(after.entries[index]).toBe(before.entries[index]);
    }
  });

  test("an update that changes nothing returns the same state object", () => {
    const before = replay();
    expect(reduce(before, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toBe(before);
    expect(reduce(before, { sessionUpdate: "plan" })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("streaming", () => {
  test("a message streams while its chunks arrive and closes when the turn ends", () => {
    const chunk = (text: string): unknown => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId: "m1",
    });
    const streaming = reduceAll(EMPTY_SESSION, [chunk("hel"), chunk("lo")]);

    expect(assistantsOf(streaming).length).toBe(1);
    expect(assistantsOf(streaming)[0]?.text).toBe("hello");
    expect(assistantsOf(streaming)[0]?.streaming).toBe(true);

    const settled = endTurn(streaming);
    expect(assistantsOf(settled)[0]?.streaming).toBe(false);
    expect(assistantsOf(settled)[0]?.text).toBe("hello");
    expect(endTurn(settled)).toBe(settled);
  });

  test("a second messageId closes the first message instead of extending it", () => {
    const state = reduceAll(EMPTY_SESSION, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" }, messageId: "a" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" }, messageId: "b" },
    ]);
    const messages = assistantsOf(state);
    expect(messages.map((message) => message.text)).toEqual(["one", "two"]);
    expect(messages.map((message) => message.streaming)).toEqual([false, true]);
  });

  test("a message resumed after a tool call rejoins its own bubble", () => {
    const state = reduceAll(EMPTY_SESSION, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before " }, messageId: "a" },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", kind: "read", status: "pending" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" }, messageId: "a" },
    ]);
    expect(assistantsOf(state).length).toBe(1);
    expect(assistantsOf(state)[0]?.text).toBe("before after");
    expect(state.entries.map((entry) => entry.kind)).toEqual(["assistant", "tool"]);
  });

  test("thinking is kept apart from the reply even under the same channel rules", () => {
    const state = reduceAll(EMPTY_SESSION, [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "weighing" }, messageId: "t" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" }, messageId: "m" },
    ]);
    const messages = assistantsOf(state);
    expect(messages.map((message) => message.thought)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Payloads this build does not know
// ---------------------------------------------------------------------------

describe("unrecognised payloads", () => {
  test("an unknown sessionUpdate becomes an inert row rather than throwing or vanishing", () => {
    const state = reduce(EMPTY_SESSION, { sessionUpdate: "quantum_entanglement_update", payload: 42 });
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.kind).toBe("unknown");
    expect(state.entries[0]).toMatchObject({ label: "quantum_entanglement_update" });
  });

  test("a malformed payload is recorded, not dropped", () => {
    expect(reduce(EMPTY_SESSION, null).entries[0]?.kind).toBe("unknown");
    expect(reduce(EMPTY_SESSION, "nonsense").entries[0]?.kind).toBe("unknown");
    expect(reduce(EMPTY_SESSION, { nothing: true }).entries[0]?.kind).toBe("unknown");
  });

  test("an update for a call that was never announced does not invent a tool card", () => {
    const state = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call_update",
      toolCallId: "ghost",
      status: "completed",
    });
    expect(toolsOf(state)).toEqual([]);
    expect(state.activity.tools).toBe(0);
    expect(state.entries[0]?.kind).toBe("unknown");
  });

  test("a repeated tool_call amends its card instead of adding a second one", () => {
    const announce = { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", kind: "read", status: "pending" };
    const state = reduceAll(EMPTY_SESSION, [announce, announce]);
    expect(toolsOf(state).length).toBe(1);
    expect(state.activity.tools).toBe(1);
  });

  test("a nested notification envelope is unwrapped rather than shown as unknown", () => {
    const state = reduce(EMPTY_SESSION, {
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    });
    expect(assistantsOf(state)[0]?.text).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// Locally originated state
// ---------------------------------------------------------------------------

describe("prompts and clearances", () => {
  test("a prompt is echoed into the timeline", () => {
    const state = appendPrompt(EMPTY_SESSION, "  read notes.md  ");
    expect(state.entries[0]).toMatchObject({ kind: "user", text: "read notes.md" });
    expect(appendPrompt(state, "   ")).toBe(state);
  });

  test("an approval lands where it interrupted the work and settles in place", () => {
    const working = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "$ rm -rf",
      kind: "execute",
      status: "pending",
    });
    const asked = appendApproval(working, {
      requestId: "r1",
      tool: "bash",
      title: "Run rm -rf",
      input: { command: "rm -rf /tmp/x" },
    });

    expect(asked.entries.map((entry) => entry.kind)).toEqual(["tool", "approval"]);
    expect(asked.pendingApprovals.length).toBe(1);
    expect(appendApproval(asked, { requestId: "r1", tool: "bash", title: "dup", input: null })).toBe(asked);

    const decided = resolveApproval(asked, "r1", "deny");
    expect(decided.pendingApprovals).toEqual([]);
    expect(decided.entries[1]).toMatchObject({ kind: "approval", decision: "deny" });
    // The tool card either side of it is untouched.
    expect(decided.entries[0]).toBe(asked.entries[0]);
  });

  test("settling a clearance nobody is waiting on is a no-op", () => {
    const state = replay();
    expect(resolveApproval(state, "missing", "allow")).toBe(state);
  });
});
