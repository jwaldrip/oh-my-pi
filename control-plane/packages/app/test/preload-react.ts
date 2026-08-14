/**
 * Pin every test import of React to the app-local copy.
 *
 * The app depends on React 19.1.4 so Metro and the RN 0.81.6 renderer agree.
 * `react-native-web` is hoisted to the workspace root, whose React is still
 * the catalog 19.2.7. Without this preload, a test that mocks `react-native`
 * to RNW ends up with two Reacts: the app's hooks and RNW's dispatcher are
 * different modules, and every render dies with "Invalid hook call".
 *
 * Bun's `--preload` runs before the test graph is evaluated. Mocking the
 * package name is not enough on its own: the JSX runtimes and `react-dom`
 * must resolve to the same physical copy, or `createRoot` and `useState` still
 * disagree about `ReactSharedInternals`.
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
const reactDomClient = appRequire("react-dom/client");

function mockAppAndWorkspace(specifier: string, value: Record<string, unknown>): void {
  mock.module(specifier, () => value);
  mock.module(workspaceRequire.resolve(specifier), () => ({ ...value, default: value }));
}

mockAppAndWorkspace("react", react);
mockAppAndWorkspace("react/jsx-runtime", jsxRuntime);
mockAppAndWorkspace("react/jsx-dev-runtime", jsxDevRuntime);
mockAppAndWorkspace("react-dom", reactDom);
mockAppAndWorkspace("react-dom/client", reactDomClient);
