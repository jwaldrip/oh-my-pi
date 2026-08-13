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

const web = await import("react-native-web");
mock.module("react-native", () => web);

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

export {};
