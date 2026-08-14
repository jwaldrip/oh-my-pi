/**
 * The screens, rendered.
 *
 * The state comes from the same pure reducer the app runs and the updates are a
 * verbatim recording of one real turn, so what is asserted here is what a
 * daemon would actually put on a phone. Rendering goes through
 * react-native-web, which is the shipped web target rather than a test double:
 * one component tree, checked the same way it runs.
 *
 * `renderToStaticMarkup` gives markup and no event loop, so presses are proven
 * separately by calling the component and walking the element tree it returns.
 * That is enough: the question a press has to answer is whether the control is
 * wired to the callback, and a real click adds a browser rather than an answer.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
// Type-only, so it is erased before it can pull `react-native` in early.
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";

// Dynamic on purpose: bun loads a file's whole static import graph before any
// module body runs, so a static import here would pull the real `react-native`
// in before `./rnw.ts` could substitute it.
const { apply, emptyConsole, fleetClearances, sessionFor } = await import("../src/console/state.ts");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { ApprovalCard } = await import("../src/components/ApprovalCard.tsx");

interface Capture {
  stream: { update: unknown }[];
}

const capture: Capture = await Bun.file(new URL("../../../scripts/update-shapes.json", import.meta.url)).json();
const STREAM: readonly unknown[] = capture.stream.map((frame) => frame.update);

/** Pinned so the strip clocks are a fact rather than a race. */
const NOW = Date.parse("2026-01-01T00:05:00.000Z");
const ACTIVE = "2026-01-01T00:04:00.000Z";

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/Users/someone/dev/src/github.com/jwaldrip/oh-my-pi",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: ACTIVE,
    labels: {},
    ...overrides,
  };
}

const FLEET: Agent[] = [
  agent("agt_0000000000000001", "cartographer", { state: "busy" }),
  agent("agt_0000000000000002", "quartermaster", { state: "waiting" }),
  agent("agt_0000000000000003", "sapper", { state: "failed", cwd: "/home/other/work/tunnel" }),
];

/** The board a daemon would have produced: a roster, a real turn, a clearance. */
function board(): ConsoleState {
  const events: ConsoleEvent[] = [
    { t: "agents", event: { agents: FLEET, deviceId: "dev_1" } },
    { t: "select", agentId: FLEET[0]?.id ?? "" },
    ...STREAM.map((update, index) => ({
      t: "update" as const,
      event: { agentId: FLEET[0]?.id ?? "", seq: index + 1, update },
    })),
    { t: "prompt", agentId: FLEET[0]?.id ?? "", text: "check the tunnel and report" },
    {
      t: "approval",
      event: {
        agentId: FLEET[0]?.id ?? "",
        requestId: "req_42",
        tool: "shell",
        title: "rm -rf ./dist",
        input: { command: "rm -rf ./dist" },
      },
    },
    { t: "say", event: { agentId: FLEET[0]?.id ?? "", seq: 40, text: "Four calls ran and the notes file is written." } },
    { t: "status", event: { state: "connected", attempt: 0 } },
  ];
  let state = emptyConsole([]);
  for (const event of events) state = apply(state, event);
  return state;
}

const STATE = board();
const OPEN = FLEET[0] as Agent;

// ---------------------------------------------------------------------------
// The bay
// ---------------------------------------------------------------------------
//
// FleetScreen's own render tests live in fleet-screen.test.tsx: its prop
// contract (a controlled `BrowserState` over every session, not just this
// device's live roster) is unrelated to the canned-frame stream this file
// drives, and a realistic corpus for it does not belong beside a three-agent
// fixture built for the transcript and approval tests below.

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

describe("the transcript renders from canned frames", () => {
  const html = renderToStaticMarkup(
    <SessionScreen
      agent={OPEN}
      session={sessionFor(STATE, OPEN.id)}
      connection={STATE.connection}
      attempt={STATE.attempt}
      canApprove
      spoken={STATE.spoken.get(OPEN.id)?.text ?? null}
      fleetClearances={fleetClearances(STATE)}
      onBack={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      onDecide={() => {}}
      onDecidePlan={() => {}}
      now={NOW}
    />,
  );

  test("the agent is named and its state shown", () => {
    expect(html).toContain("cartographer");
    expect(html).toContain("busy");
  });

  test("the captured turn's tool calls become cards", () => {
    const session = sessionFor(STATE, OPEN.id);
    const tools = session.entries.filter((entry) => entry.kind === "tool");
    expect(tools.length).toBe(4);
    for (const tool of tools) expect(html).toContain(tool.title);
  });

  test("a tool card carries its settled status", () => {
    expect(html).toContain("completed");
  });

  test("what the operator said is in the log", () => {
    expect(html).toContain("check the tunnel and report");
  });

  test("what the agent answered is in the log, as one message not seven", () => {
    const session = sessionFor(STATE, OPEN.id);
    const answer = session.entries.find((entry) => entry.kind === "assistant");
    expect(answer).toBeDefined();
    expect(html).toContain("hello-from-ompd");
  });

  test("the clearance is a card with both decisions offered", () => {
    expect(html).toContain("rm -rf ./dist");
    expect(html).toContain("Allow");
    expect(html).toContain("Reject");
    expect(html).toContain("Always");
  });

  test("the daemon's spoken summary is shown, because this build has no voice", () => {
    expect(html).toContain("Four calls ran and the notes file is written.");
  });

  test("the status readout shows the link and the spend", () => {
    expect(html).toContain("linked");
    expect(html).toContain("context");
    expect(html).toContain("spend");
    // One clearance outstanding across the fleet.
    expect(html).toContain("holding");
  });

  test("a busy agent is offered an interrupt rather than a second prompt", () => {
    // The open agent is busy, so the action is Stop. Queueing a prompt behind
    // a running turn is how two instructions become one confused one.
    expect(html).toContain("Stop");
    expect(html).not.toContain("Send");
    // The field stays editable, so the next prompt can be typed during a turn.
    expect(html).toContain("Say something to this agent");
  });

  test("an idle agent on a healthy link is offered a send", () => {
    const idle = renderToStaticMarkup(
      <SessionScreen
        agent={{ ...OPEN, state: "idle" }}
        session={sessionFor(STATE, OPEN.id)}
        connection="connected"
        attempt={0}
        canApprove
        spoken={null}
        fleetClearances={0}
        onBack={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
        now={NOW}
      />,
    );
    expect(idle).toContain("Send");
    expect(idle).not.toContain("Stop");
  });

  test("a dead link says so and refuses the composer", () => {
    const offline = renderToStaticMarkup(
      <SessionScreen
        agent={{ ...OPEN, state: "idle" }}
        session={sessionFor(STATE, OPEN.id)}
        connection="offline"
        attempt={4}
        canApprove
        spoken={null}
        fleetClearances={0}
        onBack={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
        now={NOW}
      />,
    );
    expect(offline).toContain("no link");
    expect(offline).toContain("No link");
    expect(offline).toContain("#4");
  });

  test("a device without the approve scope is told why, not just disabled", () => {
    const refused = renderToStaticMarkup(
      <SessionScreen
        agent={OPEN}
        session={sessionFor(STATE, OPEN.id)}
        connection="connected"
        attempt={0}
        canApprove={false}
        refusal="device may not approve. Sign this from a device holding the approve scope."
        spoken={null}
        fleetClearances={1}
        onBack={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
        now={NOW}
      />,
    );
    expect(refused).toContain("approve scope");
    expect(refused).not.toContain("Always");
  });

  test("the agent's browser is offered but closed until asked for", () => {
    // Mounting the sandbox registers this device as the agent's action target,
    // so a pane that opened by itself would hand the agent a browser nobody
    // asked it to drive.
    expect(html).toContain("session-browser-toggle");
    expect(html).not.toContain("session-browser\"");
    // The apostrophe arrives escaped, so the assertion stops short of it.
    expect(html).toContain("aria-label=\"Open the agent");
  });
});

// ---------------------------------------------------------------------------
// The one control that changes something
// ---------------------------------------------------------------------------

describe("the approval card is wired to a decision", () => {
  const entry = {
    kind: "approval" as const,
    id: "approval-req_42",
    requestId: "req_42",
    tool: "shell",
    title: "rm -rf ./dist",
    input: { command: "rm -rf ./dist" },
    decision: null,
  };

  function press(testID: string): [string, ApprovalChoice, ApprovalScope | undefined] | null {
    let seen: [string, ApprovalChoice, ApprovalScope | undefined] | null = null;
    const tree = ApprovalCard({
      entry,
      canApprove: true,
      onDecide: (requestId, choice, scope) => {
        seen = [requestId, choice, scope];
      },
    });
    const target = find(tree, testID);
    expect(target).not.toBeNull();
    const onPress = target === null ? undefined : Reflect.get(target.props as object, "onPress");
    if (typeof onPress !== "function") throw new Error(`${testID} has no onPress`);
    onPress();
    return seen;
  }

  test("allow sends a single-use allow", () => {
    expect(press("approval-allow-req_42")).toEqual(["req_42", "allow", "once"]);
  });

  test("reject sends a single-use deny", () => {
    expect(press("approval-deny-req_42")).toEqual(["req_42", "deny", "once"]);
  });

  test("always is a separate control, not a modifier riding on allow", () => {
    // A standing grant taken by accident is the failure this shape prevents.
    expect(press("approval-always-req_42")).toEqual(["req_42", "allow", "always"]);
  });

  test("a settled card keeps its answer and offers no further decision", () => {
    const html = renderToStaticMarkup(
      <ApprovalCard entry={{ ...entry, decision: "deny" }} canApprove onDecide={() => {}} />,
    );
    expect(html).toContain("rejected");
    expect(html).not.toContain("Allow");
  });
});

/** Depth-first search of a React element tree for a node carrying `testID`. */
function find(node: ReactNode, testID: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, testID);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props.testID === testID) return node;
  return find(props.children as ReactNode, testID);
}
