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
// RNW is hoisted and its CommonJS internals load the workspace copy of React.
// Pin the test renderer to that same physical copy, not the app-local one.
const rendererRequire = createRequire(appRequire.resolve("react-native-web"));
const react = rendererRequire("react");
const jsxRuntime = rendererRequire("react/jsx-runtime");
const jsxDevRuntime = rendererRequire("react/jsx-dev-runtime");
const reactDom = rendererRequire("react-dom");
const reactDomClient = rendererRequire("react-dom/client");
const reactDomServer = rendererRequire("react-dom/server");

mock.module("react", () => react);
mock.module("react/jsx-runtime", () => jsxRuntime);
mock.module("react/jsx-dev-runtime", () => jsxDevRuntime);
mock.module("react-dom", () => reactDom);
mock.module("react-dom/client", () => reactDomClient);
mock.module("react-dom/server", () => reactDomServer);
