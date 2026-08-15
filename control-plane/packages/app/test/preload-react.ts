/**
 * Pin every render-test import to the React copy react-native-web actually uses.
 *
 * The native app deliberately stays on React 19.1.4 for React Native 0.81.6,
 * while react-native-web is hoisted at the workspace root with React 19.2.7.
 * Bun's CJS resolver does not apply `mock.module("react", ...)` inside RNW's
 * already-loaded CJS files, so pinning JSX and React DOM to the app-local copy
 * still leaves RNW holding the root copy. The test graph must instead share
 * RNW's root React, React DOM, and JSX runtimes.
 *
 * Bun's `--preload` runs before the test graph is evaluated. Without this
 * preload the dispatcher and rendered component use different React modules,
 * which fails every hook-bearing screen with "Invalid hook call".
 */

import { mock } from "bun:test";
import { createRequire } from "node:module";

const appRequire = createRequire(import.meta.url);
const workspaceRequire = createRequire(new URL("../../../../package.json", import.meta.url));

// App code is intentionally on RN's exact React 19.1.4, while the monorepo
// catalog supplies React 19.2.7 for unrelated web packages. RNW is hoisted to
// the workspace, so its own bare imports resolve there. Mock its resolved
// module paths as well as app-facing specifiers to make the test renderer,
// RNW, and app components use the native-compatible instance.
const react = appRequire("react");
const jsxRuntime = appRequire("react/jsx-runtime");
const jsxDevRuntime = appRequire("react/jsx-dev-runtime");
const reactDom = appRequire("react-dom");
const reactDomServer = appRequire("react-dom/server");
const reactDomClient = appRequire("react-dom/client");

function mockAppAndWorkspace(specifier: string, value: Record<string, unknown>): void {
  mock.module(specifier, () => value);
  mock.module(workspaceRequire.resolve(specifier), () => ({ ...value, default: value }));
}

mockAppAndWorkspace("react", react);
mockAppAndWorkspace("react/jsx-runtime", jsxRuntime);
mockAppAndWorkspace("react/jsx-dev-runtime", jsxDevRuntime);
mockAppAndWorkspace("react-dom", reactDom);
mockAppAndWorkspace("react-dom/server", reactDomServer);
mockAppAndWorkspace("react-dom/client", reactDomClient);
