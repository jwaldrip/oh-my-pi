/**
 * Lets a bun test render the app's real React Native components.
 *
 * Two substitutions, and both are the same substitution the shipped web build
 * makes through Vite:
 *
 *  - `react-native` becomes `react-native-web`. This is what the web target
 *    does; there is no second implementation of the screens.
 *  - `react-native-svg` becomes a thin wrapper over the DOM's own `<svg>`
 *    elements, which is what that package's web build also does. It is stubbed
 *    rather than loaded because bun resolves `./elements` to the native file:
 *    picking `elements.web.js` over `elements.js` is a bundler behaviour, and
 *    bun's runtime resolver does not implement platform extensions. The stub
 *    passes path data straight through, so a rendered icon still carries its
 *    real Font Awesome geometry.
 *  - `react-native-webview` and `react-native-view-shot` become inert for the
 *    same reason one step further: both ship untranspiled Flow source that bun
 *    cannot parse at all. Stubbing them lets a test mount the session screen
 *    and drive its browser toggle, which is the wiring worth checking here.
 *    Whether a real `<WebView>` renders a page is a device question, tracked as
 *    `unverified` in `docs/browser.md`'s platform table.
 *
 * Import this module first in any test that renders. ES modules evaluate their
 * dependencies in source order, so the mocks are registered before the
 * components that need them are loaded.
 */

import { mock } from "bun:test";
import { createElement } from "react";
import type { ReactNode } from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// One registration for the whole suite. Individual tests used to register and
// unregister themselves, which is how a second file in the same process died
// with "Happy DOM has already been globally registered".
if (!(globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom) {
  GlobalRegistrator.register();
  (globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom = true;
}

const web = await import("react-native-web");

/** Live hardware-back handlers. Tests read and clear this set. */
export type BackHandlerFn = () => boolean;
const handlers = new Set<BackHandlerFn>();

/** Drop every armed hardware-back handler. Call from afterEach. */
export function resetBackHandlers(): void {
  handlers.clear();
}

/** How many hardware-back handlers are currently armed. */
export function backHandlerCount(): number {
  return handlers.size;
}

/**
 * Fire every armed hardware-back handler and return each claim result.
 * An empty array means nothing was listening.
 */
export function pressHardwareBack(): boolean[] {
  return [...handlers].map((handler) => handler());
}

/** Window size seen by `useWindowDimensions`. RNW refuses Dimensions.set in the browser. */
let windowSize = { width: 390, height: 844, scale: 1, fontScale: 1 };

/** Point `useWindowDimensions` at a specific width for the next render. */
export function setWindowWidth(width: number): void {
  windowSize = { ...windowSize, width };
}

/** Restore the phone-width default after a wide render. */
export function resetWindowSize(): void {
  windowSize = { width: 390, height: 844, scale: 1, fontScale: 1 };
}

mock.module("react-native", () => ({
  ...web,
  // happy-dom has no app lifecycle. A no-op subscription keeps useConsole's
  // foreground-reconnect effect from throwing on unmount.
  AppState: {
    addEventListener: () => ({ remove: () => {} }),
    currentState: "active",
  },
  BackHandler: {
    addEventListener: (_event: string, handler: BackHandlerFn) => {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    },
  },
  useWindowDimensions: () => windowSize,
}));

/** `react-native-svg`'s element names, mapped onto their DOM equivalents. */
const SVG_ELEMENTS = ["Svg", "Path", "Rect", "Circle", "Ellipse", "Line", "G", "Defs", "Mask", "ClipPath"] as const;

interface SvgProps {
  children?: ReactNode;
  [key: string]: unknown;
}

const stub: Record<string, unknown> = {};
for (const name of SVG_ELEMENTS) {
  const tag = name === "Svg" ? "svg" : name === "ClipPath" ? "clipPath" : name.toLowerCase();
  const component = ({ children, ...props }: SvgProps) => createElement(tag, props, children);
  component.displayName = name;
  stub[name] = component;
}
stub.default = stub.Svg;

mock.module("react-native-svg", () => stub);

// Renders nothing and answers nothing: `WebViewDriver` owns every reply
// through its own ref handle, so a stub that pretended to navigate would be
// inventing behaviour no test is entitled to assert.
const webView: Record<string, unknown> = {};
webView.WebView = ({ children }: SvgProps) => children ?? null;
webView.default = webView.WebView;
mock.module("react-native-webview", () => webView);

mock.module("react-native-view-shot", () => ({
  captureRef: () => Promise.reject(new Error("captureRef is unavailable under bun test")),
}));

// Zero insets under bun test: there is no system chrome in happy-dom, and the
// real package reaches into native modules bun cannot load. Screens still
// mount their SafeScreen shell so a missing provider would fail the same way
// it would on device.
mock.module("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
