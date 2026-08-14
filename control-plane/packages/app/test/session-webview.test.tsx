/**
 * When a selected session offers and withdraws its embedded WebView target.
 *
 * Registration belongs to the selected screen, not to the human's pane
 * preference: an inbound action must be able to open the sandbox itself. The
 * count still matters as much as the order. A screen that re-registers on
 * every update frame creates a window where the daemon sees no target for an
 * agent that never actually left.
 *
 * This file therefore renders for real, through react-dom into a happy-dom
 * document, rather than asserting markup: the property under test is a
 * lifecycle, and only a second render can show it.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Agent } from "@ompd/core/contracts";
import type { PendingWebViewAction } from "../src/console/state.ts";
import { EMPTY_SESSION } from "../src/session/model.ts";

// Dynamic on purpose, the same way `smoke.test.tsx` loads its screens: bun
// evaluates a file's whole static import graph before any module body runs, so
// a static import here would pull the real `react-native` in before `./rnw.ts`
// could substitute it, and the real DOM globals before happy-dom is registered.
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");

// React 19 reads this to decide whether act() is legal outside a test
// renderer. It is React's own contract with a test host and no shipped type
// declares it, so the declaration belongs here rather than at a call site.
declare global {
  // `var` is what a global declaration takes; `let`/`const` do not reach globalThis.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: Agent = {
  id: "agt_0000000000000001",
  name: "cartographer",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  labels: {},
};

interface Harness {
  /** Every mount and unmount, in order, as the screen reported them. */
  calls: string[];
  /** Render again with fresh callback identities, as a real parent does. */
  rerender: (agent?: Agent) => void;
  toggle: () => void;
  browserIsOpen: () => boolean;
  unmount: () => void;
}

function mountScreen(pendingWebViewAction?: PendingWebViewAction): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls: string[] = [];

  const draw = (agent: Agent): void => {
    act(() => {
      root.render(
        <SessionScreen
          agent={agent}
          session={EMPTY_SESSION}
          connection="connected"
          attempt={0}
          canApprove
          spoken={null}
          fleetClearances={0}
          onBack={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          pendingWebViewAction={pendingWebViewAction}
          // Fresh closures every render, exactly as `Console` builds them.
          onMountWebView={() => {
            calls.push("mount");
          }}
          onUnmountWebView={() => {
            calls.push("unmount");
          }}
        />,
      );
    });
  };

  let current = AGENT;
  draw(current);

  return {
    calls,
    rerender: (agent) => {
      current = agent ?? current;
      draw(current);
    },
    toggle: () => {
      const button = host.querySelector('[data-testid="session-browser-toggle"]');
      // A `<button>` this file just rendered: the DOM's own type is what the
      // query cannot know, and there is nothing to validate.
      const control = button as HTMLElement | null;
      if (control === null) throw new Error("the browser toggle is not on screen");
      act(() => {
        control.click();
      });
    },
    browserIsOpen: () => host.querySelector('[data-testid="session-browser"]') !== null,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}


describe("the session screen's WebView registration", () => {
  test("a selected screen registers even while its browser pane is closed", () => {
    const h = mountScreen();
    h.rerender();
    expect(h.calls).toEqual(["mount"]);
    h.unmount();
  });

  test("opening the pane does not churn the selected screen's registration", () => {
    const h = mountScreen();
    h.toggle();
    expect(h.calls).toEqual(["mount"]);
    h.unmount();
  });

  test("an inbound action opens the sandbox even when the human left it closed", () => {
    const h = mountScreen({ requestId: "request-1", action: { kind: "observe" } });
    expect(h.browserIsOpen()).toBe(true);
    h.unmount();
  });

  test("re-rendering with fresh callbacks does not churn the registration", () => {
    // The defect this exists to catch: a live turn re-renders the log
    // constantly, and each of those would otherwise withdraw and re-offer.
    const h = mountScreen();
    h.rerender();
    h.rerender({ ...AGENT, state: "busy" });
    h.rerender({ ...AGENT, lastActiveAt: "2026-01-01T00:01:00.000Z" });
    expect(h.calls).toEqual(["mount"]);
    h.unmount();
  });

  test("closing and reopening the pane leaves the target registered", () => {
    const h = mountScreen();
    h.toggle();
    h.toggle();
    expect(h.calls).toEqual(["mount"]);
    h.toggle();
    expect(h.calls).toEqual(["mount"]);
    h.unmount();
  });

  test("switching to another agent moves the registration rather than keeping both", () => {
    // The registration names an agent. Carrying it silently onto the next one
    // would hand a second agent a target nobody offered it.
    const h = mountScreen();
    h.rerender({ ...AGENT, id: "agt_0000000000000002", name: "quartermaster" });
    expect(h.calls).toEqual(["mount", "unmount", "mount"]);
    h.unmount();
  });

  test("leaving the selected screen withdraws its target", () => {
    const h = mountScreen();
    h.unmount();
    expect(h.calls).toEqual(["mount", "unmount"]);
  });
});
