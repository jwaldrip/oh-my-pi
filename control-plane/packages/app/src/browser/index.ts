/**
 * The agent-driveable WebView, as a capability a screen can check for and
 * mount. See `docs/browser.md` for the full contract.
 *
 * This is the native (`ios`/`android`/`macos`/`windows`) entry point; Metro
 * resolves it for any target `.web.ts` does not claim. `index.web.ts` is the
 * counterpart that makes the capability's absence on the web build a type,
 * not a runtime surprise.
 *
 * `WebViewCapability` lives here rather than in `@ompd/core/contracts`
 * because it names a React component: `core/contracts.ts` is shared with the
 * daemon, which runs under Bun with no React in its dependency graph, and
 * `WebViewAction`/`WebViewObservation`/etc there are the wire shapes both
 * sides agree on, not this app's own UI-layer wrapper around one of them.
 */

import type { WebViewPlatformStatus } from "@ompd/core/contracts";
import { WEBVIEW_PLATFORM_STATUS } from "./capability.ts";
import { WebViewDriver } from "./WebViewDriver.tsx";

export type { WebViewDriverHandle, WebViewDriverProps } from "./WebViewDriver.tsx";
export { WEBVIEW_PLATFORM_STATUS } from "./capability.ts";
export { parseBridgeMessage, type BridgeEvent } from "./bridge.ts";

export interface WebViewCapability {
  Driver: typeof WebViewDriver;
  platformStatus: readonly WebViewPlatformStatus[];
}

export const webViewCapability: WebViewCapability = {
  Driver: WebViewDriver,
  platformStatus: WEBVIEW_PLATFORM_STATUS,
};
