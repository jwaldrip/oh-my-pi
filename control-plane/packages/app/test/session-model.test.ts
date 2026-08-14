/**
 * The reducer, ported byte-identically from the PWA, retested here.
 *
 * The point of running these again rather than trusting the web package's copy
 * is the port itself: this is the file the app actually imports, and a reducer
 * that drifted during the move would fail here and nowhere else. The fixture is
 * a verbatim recording of one real turn, so the assertions are about what an
 * ACP stream does rather than about what this implementation happens to do.
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
export const STREAM: readonly unknown[] = capture.stream.map((frame) => frame.update);

function toolsOf(state: SessionState): ToolEntry[] {
  return state.entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
}

describe("a captured turn", () => {
  test("the fixture is the shape these tests claim it is", () => {
    // Guards the tests themselves: a regenerated capture with different counts
    // would otherwise quietly weaken every assertion below.
    expect(capture.counts.tool_call).toBe(4);
    expect(capture.counts.tool_call_update).toBe(6);
    expect(capture.counts.agent_message_chunk).toBe(7);
    expect(STREAM.length).toBe(23);
  });

  test("four announced calls become four cards, not ten", () => {
    // Ten payloads mention a tool. A card per payload is the bug this catches.
    const state = reduceAll(EMPTY_SESSION, STREAM);
    expect(toolsOf(state).length).toBe(4);
    expect(state.activity.tools).toBe(4);
  });

  test("seven chunks coalesce into one message per messageId", () => {
    const state = reduceAll(EMPTY_SESSION, STREAM);
    const assistants = state.entries.filter((entry): entry is AssistantEntry => entry.kind === "assistant");
    const ids = new Set(
      STREAM.filter(
        (update) =>
          typeof update === "object" && update !== null && Reflect.get(update, "sessionUpdate") === "agent_message_chunk",
      ).map((update) => Reflect.get(update as object, "messageId")),
    );
    // Seven payloads, two messages. A bubble per chunk is the bug this catches.
    expect(ids.size).toBe(2);
    expect(assistants.length).toBe(2);
    expect(assistants[0]?.text.length).toBeGreaterThan(40);
  });

  test("a settled turn leaves nothing streaming", () => {
    const state = endTurn(reduceAll(EMPTY_SESSION, STREAM));
    const streaming = state.entries.filter((entry) => entry.kind === "assistant" && entry.streaming);
    expect(streaming.length).toBe(0);
  });

  test("usage survives the replay", () => {
    const state = reduceAll(EMPTY_SESSION, STREAM);
    expect(state.usage).not.toBeNull();
    expect(state.usage?.size).toBeGreaterThan(0);
  });

  test("the reducer never scribbles on the state it was handed", () => {
    // Reference sharing is what lets the list skip rows; mutation would make
    // the transcript diff correct and the render wrong.
    const before = reduceAll(EMPTY_SESSION, STREAM.slice(0, 12));
    const entriesBefore = before.entries;
    const snapshot = entriesBefore.map((entry) => ({ ...entry }));
    reduceAll(before, STREAM.slice(12));
    expect(before.entries).toBe(entriesBefore);
    expect(before.entries.map((entry) => ({ ...entry }))).toEqual(snapshot);
  });
});

describe("locally originated state", () => {
  test("a prompt appears before the daemon says anything", () => {
    const state = appendPrompt(EMPTY_SESSION, "  run the build  ");
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]).toMatchObject({ kind: "user", text: "run the build" });
  });

  test("an empty prompt is not an entry", () => {
    expect(appendPrompt(EMPTY_SESSION, "   ")).toBe(EMPTY_SESSION);
  });

  test("a clearance is pending until it is settled, then keeps its answer", () => {
    const asked = appendApproval(EMPTY_SESSION, {
      requestId: "req-1",
      tool: "shell",
      title: "rm -rf build",
      input: { command: "rm -rf build" },
    });
    expect(asked.pendingApprovals.length).toBe(1);

    const settled = resolveApproval(asked, "req-1", "deny");
    expect(settled.pendingApprovals.length).toBe(0);
    // The card stays. A clearance that vanishes leaves no evidence of what was
    // approved, which is the whole reason it is in the timeline.
    expect(settled.entries.length).toBe(1);
    expect(settled.entries[0]).toMatchObject({ kind: "approval", decision: "deny" });
  });

  test("the same clearance asked twice is one card", () => {
    const approval = { requestId: "req-1", tool: "shell", title: "ls", input: null };
    const once = appendApproval(EMPTY_SESSION, approval);
    expect(appendApproval(once, approval)).toBe(once);
  });
});

describe("payloads this build has never seen", () => {
  test("an unknown update is an inert row rather than a dropped one", () => {
    const state = reduce(EMPTY_SESSION, { sessionUpdate: "quantum_entanglement_update", detail: 1 });
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]).toMatchObject({ kind: "unknown", label: "quantum_entanglement_update" });
  });

  test("a malformed update does not throw", () => {
    expect(reduce(EMPTY_SESSION, null).entries[0]).toMatchObject({ kind: "unknown" });
    expect(reduce(EMPTY_SESSION, { nope: true }).entries[0]).toMatchObject({ kind: "unknown" });
  });
});
