/**
 * The native driver: a sandboxed `<WebView>` an agent's `webview_*` tool
 * calls act against, via `injectJavaScript`/`onMessage` for
 * observe/click/type and `react-native-view-shot` for screenshot.
 *
 * Own sandbox, not the operator's browser. `react-native-webview` gives each
 * `<WebView>` its own cookie jar and storage, isolated from the rest of this
 * app and from any other app on the device -- see "What the agent can and
 * cannot see" in `docs/browser.md`. Nothing here reaches the device's system
 * browser, its saved credentials, or this app's own `platform/connection.ts`
 * pairing state, which lives entirely outside the WebView.
 *
 * `navigate` and `screenshot` are handled here, not by the injected script:
 * navigation would unload the page before an in-page `postMessage` reliably
 * fired, and a screenshot captures the native view, which page JS cannot do.
 * `observe`/`click`/`type` round-trip through `bridge.ts`'s nonce-correlated
 * message channel -- see that file for why a page's own content can never
 * become one of these calls on its own.
 */

import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { captureRef } from "react-native-view-shot";
import type { WebViewAction, WebViewActionResult } from "@ompd/core/contracts";
import { undriveableUrlReason } from "@ompd/core/policy";
import { buildInjectedScript, mintNonce, parseBridgeMessage } from "./bridge.ts";

export interface WebViewDriverHandle {
  /** Perform one action. Resolves to an error result rather than throwing or hanging silently -- see the module doc on `navigate`/`screenshot`. */
  act(action: WebViewAction): Promise<WebViewActionResult>;
}

export interface WebViewDriverProps {
  /** Where the sandbox starts. Defaults to a blank page, never the app's own last-visited URL from a prior session -- each mount is a fresh sandbox. */
  initialUrl?: string;
  style?: StyleProp<ViewStyle>;
  /** How long one action waits for the page (or the native capture) to answer before failing rather than hanging the caller forever. */
  timeoutMs?: number;
  /**
   * A navigation this WebView refused, with the reason. Worth surfacing rather
   * than swallowing: a page that tried to open the phone's dialer is something
   * an operator should be told about, and an agent whose click went nowhere is
   * otherwise left guessing why the page did not change.
   */
  onRefusedNavigation?: (url: string, reason: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Exception to the project's ReturnType-as-contract rule: this names a
// builtin ambient global's timer handle, whose concrete type depends on
// which lib config wins (Node's `Timeout` vs the DOM's `number`) rather than
// on any contract this module owns, so pinning a literal type here would be
// the thing that silently breaks across tsconfig/environment changes.
type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingBridgeCall {
  nonce: string;
  resolve: (result: WebViewActionResult) => void;
  timer: TimerHandle;
}

interface PendingNavigate {
  resolve: (result: WebViewActionResult) => void;
  timer: TimerHandle;
}

export const WebViewDriver = forwardRef<WebViewDriverHandle, WebViewDriverProps>(function WebViewDriver(props, ref) {
  const webViewRef = useRef<WebView<object>>(null);
  const containerRef = useRef<View>(null);
  const pendingRef = useRef<PendingBridgeCall | null>(null);
  const pendingNavigateRef = useRef<PendingNavigate | null>(null);
  const timeoutMs = props.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const settlePending = useCallback((result: WebViewActionResult) => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
    pending.resolve(result);
  }, []);

  const runInPage = useCallback(
    (action: WebViewAction): Promise<WebViewActionResult> => {
      if (pendingRef.current) {
        return Promise.resolve({ kind: "error", message: "another webview action is already in flight" });
      }
      const view = webViewRef.current;
      if (!view) return Promise.resolve({ kind: "error", message: "webview is not mounted" });

      return new Promise<WebViewActionResult>((resolve) => {
        const nonce = mintNonce();
        const timer = setTimeout(() => {
          if (pendingRef.current?.nonce === nonce) {
            pendingRef.current = null;
            resolve({ kind: "error", message: "the page did not answer within the timeout" });
          }
        }, timeoutMs);
        pendingRef.current = { nonce, resolve, timer };
        view.injectJavaScript(buildInjectedScript(nonce, action));
      });
    },
    [timeoutMs],
  );

  const navigate = useCallback(
    (url: string): Promise<WebViewActionResult> => {
      const view = webViewRef.current;
      if (!view) return Promise.resolve({ kind: "error", message: "webview is not mounted" });
      if (pendingNavigateRef.current) {
        return Promise.resolve({ kind: "error", message: "another navigation is already in flight" });
      }
      return new Promise<WebViewActionResult>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingNavigateRef.current) {
            pendingNavigateRef.current = null;
            resolve({ kind: "error", message: "navigation did not finish within the timeout" });
          }
        }, timeoutMs);
        pendingNavigateRef.current = { resolve, timer };
        view.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
      });
    },
    [timeoutMs],
  );

  const screenshot = useCallback((): Promise<WebViewActionResult> => {
    const container = containerRef.current;
    if (!container) return Promise.resolve({ kind: "error", message: "webview is not mounted" });
    return captureRef(container, { format: "png", result: "base64" })
      .then((pngBase64): WebViewActionResult => ({ kind: "screenshot", pngBase64 }))
      .catch(
        (err: unknown): WebViewActionResult => ({
          kind: "error",
          message: `screenshot capture failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      act: (action) => {
        switch (action.kind) {
          case "navigate":
            return navigate(action.url);
          case "screenshot":
            return screenshot();
          case "observe":
          case "click":
          case "type":
            return runInPage(action);
        }
      },
    }),
    [navigate, screenshot, runInPage],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const pending = pendingRef.current;
      const parsed = parseBridgeMessage(pending?.nonce ?? null, event.nativeEvent.data);
      // `dropped` is not surfaced to the caller and never becomes an action:
      // page content that does not match the one outstanding request is
      // exactly what a page talking without being asked looks like.
      if (parsed.kind === "resolved") settlePending(parsed.result);
    },
    [settlePending],
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    if (nav.loading) return;
    const pending = pendingNavigateRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingNavigateRef.current = null;
    pending.resolve({ kind: "ack", url: nav.url, title: nav.title });
  }, []);

  /**
   * The last word on what this WebView loads, and the only one that sees a
   * navigation no tool call made: a redirect the page issued, a link the agent
   * clicked, a form that posts somewhere else. The daemon checks the URL an
   * agent asked for; nothing but this sees the URL a page chose.
   *
   * Refusing here rather than narrowing `originWhitelist` is deliberate.
   * `react-native-webview` does not simply decline a URL outside that list: it
   * hands it to `Linking.openURL`, which is the OS asking another app to open
   * it. A page inside the agent's sandbox could then launch the phone's mail
   * client, dialer, or App Store. Returning false stops the load without
   * offering it to anything else.
   */
  const onShouldStartLoadWithRequest = useCallback(
    (request: WebViewNavigation & { isTopFrame: boolean }) => {
      const reason = undriveableUrlReason(request.url);
      if (reason === null) return true;
      props.onRefusedNavigation?.(request.url, reason);
      return false;
    },
    [props.onRefusedNavigation],
  );

  return (
    <View ref={containerRef} style={props.style ?? { flex: 1 }}>
      <WebView<object>
        ref={webViewRef}
        source={{ uri: props.initialUrl ?? "about:blank" }}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
        // A non-persistent data store, which is what makes the "fresh sandbox"
        // claim in this file's header true rather than aspirational. Cookies and
        // `localStorage` written here do not survive the mount, so a login an
        // agent performed cannot be inherited by whatever mounts next, and
        // nothing it touched is left on disk for a later session to find.
        //
        // `incognito={false}`, which this used to pass explicitly, puts the
        // WebView in the app's shared persistent store: storage would outlive
        // the pane, be visible to every other WebView the app creates, and
        // survive a relaunch. See `docs/browser.md`.
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        incognito
        javaScriptEnabled
        // Every load already passes `onShouldStartLoadWithRequest` above, which
        // is a stricter rule than any origin list and, unlike one, never hands a
        // refused URL to `Linking.openURL`.
        originWhitelist={["*"]}
      />
    </View>
  );
});
