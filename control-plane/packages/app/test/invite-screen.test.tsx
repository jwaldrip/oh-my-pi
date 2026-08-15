/**
 * `InviteScreen`'s two-request mint: the scope it requests for a new device
 * defaults to exactly the scopes this device already holds, and a widened
 * request the daemon refuses (`scope_escalation`) surfaces as a plain
 * message rather than an unhandled rejection or a crash.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way every other screen test in this directory
// loads its screen: bun evaluates a file's whole static import graph before
// its body runs, so a static import here would pull the real `react-native`
// in before `./rnw.ts` could substitute it.
const { InviteScreen } = await import("../src/screens/InviteScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_owner",
  scopes: ["read", "approve"],
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * A sequenced fetch double: each call to `/v1/pair` or `/v1/pairings/approve`
 * consumes the next queued response for that route, so a test can make the
 * device's *second* mint (after the operator widens the scope selection)
 * behave differently from its first without a real daemon.
 */
function stubFetch(routes: {
  pair?: Array<{ status?: number; body: unknown }>;
  approve?: Array<{ status?: number; body: unknown }>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  let pairIndex = 0;
  let approveIndex = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/pair")) {
      const entry = routes.pair?.[pairIndex] ?? { body: { code: "000000" } };
      pairIndex += 1;
      return new Response(JSON.stringify(entry.body), { status: entry.status ?? 200 });
    }
    if (url.endsWith("/v1/pairings/approve")) {
      const entry = routes.approve?.[approveIndex] ?? { body: { token: "tok_default", name: "device" } };
      approveIndex += 1;
      return new Response(JSON.stringify(entry.body), { status: entry.status ?? 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

/** Drains the microtask queue a mint's fetch/json/setState chain runs on, inside `act` so React commits the result. This is a test seam, not app behavior: nothing in `InviteScreen` itself waits on a timer. */
async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

function el(host: HTMLElement, testID: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testID}"]`);
}

describe("InviteScreen: minting a second device's credential", () => {
  test("defaults the requested scopes to this device's own scopes and reaches the ready state", async () => {
    const calls = stubFetch({
      pair: [{ body: { code: "424242" } }],
      approve: [{ body: { token: "tok_new", name: "New device" } }],
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<InviteScreen connection={CONNECTION} onDone={() => {}} />);
    });
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:7777/v1/pair");
    const approveCall = calls[1];
    expect(approveCall?.url).toBe("http://127.0.0.1:7777/v1/pairings/approve");
    expect(JSON.parse(String(approveCall?.init?.body))).toEqual({ code: "424242", scopes: ["read", "approve"] });
    expect((approveCall?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok_owner");

    expect(el(host, "invite-qr")).not.toBeNull();
    expect(el(host, "invite-error")).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a widened scope selection the daemon refuses surfaces scope_escalation without crashing", async () => {
    const calls = stubFetch({
      pair: [{ body: { code: "111111" } }, { body: { code: "222222" } }],
      approve: [
        { body: { token: "tok_first", name: "New device" } },
        { status: 403, body: { error: "scope_escalation", missing: ["manage"] } },
      ],
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<InviteScreen connection={CONNECTION} onDone={() => {}} />);
    });
    await settle();
    expect(el(host, "invite-qr")).not.toBeNull();

    // Widen past this device's own scopes -- `manage` isn't in `CONNECTION.scopes`.
    act(() => {
      el(host, "invite-scope-manage")?.click();
    });
    act(() => {
      el(host, "invite-generate")?.click();
    });
    await settle();

    expect(calls).toHaveLength(4);
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ code: "222222", scopes: ["read", "approve", "manage"] });

    const error = el(host, "invite-error");
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("manage");
    // Refused, not crashed: the screen is still mounted and interactive.
    expect(el(host, "invite-generate")).not.toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
