/**
 * Routing one dispatched WebView action to the view that can perform it.
 *
 * Split out of `useConsole` for the same reason `state.ts` is: the socket is
 * impure and the decision is not. The decision here is small but load-bearing,
 * because every branch has to end in exactly one answer. The daemon holds the
 * agent's tool call open until a `webview_result` arrives, so a branch that
 * returns without answering is a hung model, and a branch that answers twice
 * settles a request the second answer knows nothing about.
 */

import type { WebViewAction, WebViewActionResult } from "@ompd/core/contracts";

/**
 * What a mounted WebView has to be able to do, named here rather than imported
 * from `../browser/`: that module pulls in `react-native-webview`, which the
 * web build resolves to a capability of `null`. `WebViewDriverHandle` satisfies
 * this structurally, so the platform stays the screen's problem.
 */
export interface WebViewTarget {
  act(action: WebViewAction): Promise<WebViewActionResult>;
}

/**
 * The answer sent when an action arrives for an agent whose WebView this client
 * no longer holds: a pane that closed between the daemon's dispatch and the
 * frame landing. Failing now beats letting the tool call wait out the bridge's
 * full device timeout for a view that is gone.
 */
export const NO_MOUNTED_WEBVIEW = "the client's WebView unmounted before the action arrived";

/**
 * Perform `action` on `target` and hand the result to `reply`, exactly once.
 *
 * Returns a promise so a test can await the settled answer; callers on the
 * socket path ignore it, because there is nothing left to do with it.
 */
export async function routeWebViewAction(
  target: WebViewTarget | undefined,
  action: WebViewAction,
  reply: (result: WebViewActionResult) => void,
): Promise<void> {
  if (target === undefined) {
    reply({ kind: "error", message: NO_MOUNTED_WEBVIEW });
    return;
  }
  try {
    reply(await target.act(action));
  } catch (cause) {
    // The driver answers its own failures with an error result, so a throw is
    // the driver itself breaking. Answering anyway is what keeps the agent's
    // tool call from hanging on a bug in this app.
    reply({ kind: "error", message: `the WebView driver threw: ${String(cause)}` });
  }
}
