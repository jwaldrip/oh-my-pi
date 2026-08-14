/**
 * Routing a dispatched WebView action, which has exactly one hard rule: every
 * path answers once.
 *
 * The daemon holds the agent's tool call open on a pending row until a
 * `webview_result` arrives. So the interesting cases are not the happy one:
 * they are the pane that closed before the frame landed, and the driver that
 * threw instead of resolving. Both of those are how a model ends up waiting on
 * a device that is never going to speak.
 */

import { describe, expect, test } from "bun:test";
import type { WebViewAction, WebViewActionResult } from "@ompd/core/contracts";
import { NO_MOUNTED_WEBVIEW, routeWebViewAction } from "../src/console/webview.ts";

const OBSERVE: WebViewAction = { kind: "observe" };

/** Collects every answer, so "answered twice" is visible rather than hidden. */
function replies(): { seen: WebViewActionResult[]; reply: (result: WebViewActionResult) => void } {
  const seen: WebViewActionResult[] = [];
  return {
    seen,
    reply: (result) => {
      seen.push(result);
    },
  };
}

describe("routing a dispatched action", () => {
  test("an action with no mounted view is refused immediately", async () => {
    const { seen, reply } = replies();
    await routeWebViewAction(undefined, OBSERVE, reply);
    expect(seen).toEqual([{ kind: "error", message: NO_MOUNTED_WEBVIEW }]);
  });

  test("the mounted view's own result is forwarded verbatim", async () => {
    const answer: WebViewActionResult = {
      kind: "observe",
      observation: {
        url: "https://example.com",
        title: "Example",
        settled: true,
        tree: { tag: "body", ref: "n0", text: "hello" },
      },
    };
    const { seen, reply } = replies();
    await routeWebViewAction({ act: () => Promise.resolve(answer) }, OBSERVE, reply);
    expect(seen).toEqual([answer]);
  });

  test("the action it was given is the action performed", async () => {
    const performed: WebViewAction[] = [];
    const click: WebViewAction = { kind: "click", ref: "n7" };
    const { reply } = replies();
    await routeWebViewAction(
      {
        act: (action) => {
          performed.push(action);
          return Promise.resolve<WebViewActionResult>({
            kind: "ack",
            url: "https://example.com",
            title: "Example",
          });
        },
      },
      click,
      reply,
    );
    expect(performed).toEqual([click]);
  });

  test("a driver that throws still answers, so the tool call cannot hang", async () => {
    const { seen, reply } = replies();
    await routeWebViewAction({ act: () => Promise.reject(new Error("ref is stale")) }, OBSERVE, reply);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error" });
    expect(seen[0]?.kind === "error" ? seen[0].message : "").toContain("ref is stale");
  });

  test("a driver that throws synchronously is caught the same way", async () => {
    const { seen, reply } = replies();
    await routeWebViewAction(
      {
        act: () => {
          throw new Error("no webview is mounted");
        },
      },
      OBSERVE,
      reply,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error" });
  });
});
