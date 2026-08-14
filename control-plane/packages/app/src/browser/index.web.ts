/**
 * The web build's answer to "drive a WebView": there isn't one, on purpose.
 *
 * A browser tab cannot honestly host a driveable browser inside itself --
 * there is no second content process to sandbox it in, no separate storage
 * partition from the tab's own, and "the agent's own browser" would just be
 * the visitor's own tab. See "Why this is not the browser/computer tool" and
 * the web row of the capability matrix in `docs/browser.md`.
 *
 * `webViewCapability` is typed as the literal `null`, not `WebViewCapability
 * | null`: a caller cannot compile code on this target that reads
 * `webViewCapability.Driver`, because there is no such property on the type
 * `null`. This is `.web.ts` -- resolved by Vite the same way Metro resolves
 * `.ios.tsx`/`.android.tsx` (see `vite.config.ts`'s `resolve.extensions`) --
 * so the absence is a build-time fact, not a runtime branch this module has
 * to remember to take.
 *
 * The real mechanism for "the agent's own browser" on desktop is the OMP
 * browser relay, driving the operator's actual Chrome. That is out of this
 * slice's scope; it is not replaced by this file, which replaces nothing.
 */

export const webViewCapability: null = null;

export { WEBVIEW_PLATFORM_STATUS } from "./capability.ts";
