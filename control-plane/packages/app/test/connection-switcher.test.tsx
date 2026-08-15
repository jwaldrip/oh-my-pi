/** The saved-daemon chooser exposes selection and a reversible add path. */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionList } from "../src/platform/connection.ts";

const { ConnectionSwitcherScreen } = await import("../src/screens/ConnectionSwitcherScreen.tsx");
const { PairScreen } = await import("../src/screens/PairScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const connections: ConnectionList = {
  activeId: "local",
  connections: [
    {
      id: "local",
      label: "Local",
      connection: { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_local", scopes: [] },
    },
    {
      id: "cloud",
      label: "Cloud",
      connection: { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "dmn_cloud", token: "tok_cloud", scopes: [] },
    },
  ],
};

function button(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} control rendered`);
  return element;
}

describe("ConnectionSwitcherScreen", () => {
  test("selects a saved daemon, opens add, and lets pairing return to the chooser", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const selected: string[] = [];
    let adding = false;
    let cancelled = false;

    act(() => {
      root.render(
        <ConnectionSwitcherScreen
          connections={connections}
          onAdd={() => {
            adding = true;
          }}
          onBack={() => {}}
          onSelect={(id) => selected.push(id)}
        />,
      );
    });
    act(() => {
      button(host, "connection-cloud").click();
      button(host, "add-connection").click();
    });
    expect(selected).toEqual(["cloud"]);
    expect(adding).toBe(true);

    act(() => {
      root.render(<PairScreen onCancel={() => { cancelled = true; }} onPair={() => {}} />);
    });
    act(() => {
      button(host, "pair-cancel").click();
    });
    expect(cancelled).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("the invite entry point is absent when the active connection's scopes exclude approve", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<ConnectionSwitcherScreen connections={connections} onAdd={() => {}} onBack={() => {}} onSelect={() => {}} />);
    });
    expect(host.querySelector('[data-testid="invite-device"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("holding approve on the active connection surfaces an invite entry point that opens InviteScreen", async () => {
    const approving: ConnectionList = {
      activeId: "local",
      connections: [
        {
          id: "local",
          label: "Local",
          connection: { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_local", scopes: ["read", "approve"] },
        },
      ],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    // InviteScreen mints on mount; this test is only about the switcher's
    // gating and screen swap, so the mint itself is stubbed out rather than
    // reaching a real daemon.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network unavailable in test");
    }) as unknown as typeof fetch;

    act(() => {
      root.render(<ConnectionSwitcherScreen connections={approving} onAdd={() => {}} onBack={() => {}} onSelect={() => {}} />);
    });
    expect(button(host, "invite-device")).not.toBeNull();

    act(() => {
      button(host, "invite-device").click();
    });
    expect(host.querySelector('[data-testid="invite"]')).not.toBeNull();

    // Let InviteScreen's stubbed mint reject and settle before tearing down,
    // so no promise is still in flight against an unmounted tree.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    globalThis.fetch = originalFetch;
    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
