/**
 * Android hardware back returns to the sessions list and claims the event.
 *
 * Uses the real `useHardwareBack` hook against the single BackHandler mock in
 * `rnw.ts`, so the production subscription shape is what fails this file.
 */

import "./rnw.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { backHandlerCount, pressHardwareBack, resetBackHandlers } from "./rnw.ts";

const { useHardwareBack } = await import("../src/console/useHardwareBack.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetBackHandlers();
});

function Probe({ armed, onBack }: { armed: boolean; onBack: () => void }) {
  useHardwareBack(armed, onBack);
  return createElement("div", { "data-testid": "probe" }, armed ? "armed" : "idle");
}

describe("useHardwareBack", () => {
  test("arms only while a session is open, claims the event, and calls back", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let backed = 0;
    const onBack = () => {
      backed += 1;
    };

    act(() => {
      root.render(createElement(Probe, { armed: false, onBack }));
    });
    expect(backHandlerCount()).toBe(0);

    act(() => {
      root.render(createElement(Probe, { armed: true, onBack }));
    });
    expect(backHandlerCount()).toBe(1);

    expect(pressHardwareBack()).toEqual([true]);
    expect(backed).toBe(1);

    act(() => {
      root.render(createElement(Probe, { armed: false, onBack }));
    });
    expect(backHandlerCount()).toBe(0);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("unmount removes the listener so a later back does not fire a dead callback", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let backed = 0;

    act(() => {
      root.render(
        createElement(Probe, {
          armed: true,
          onBack: () => {
            backed += 1;
          },
        }),
      );
    });
    expect(backHandlerCount()).toBe(1);

    act(() => {
      root.unmount();
    });
    expect(backHandlerCount()).toBe(0);
    expect(backed).toBe(0);
    expect(pressHardwareBack()).toEqual([]);
    host.remove();
  });
});
