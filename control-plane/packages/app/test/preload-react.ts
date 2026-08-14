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

const require = createRequire(import.meta.url);

// Resolve from this file's location (the app package), not from the workspace
// root bun happened to start in.
const react = require("react");
const jsxRuntime = require("react/jsx-runtime");
const jsxDevRuntime = require("react/jsx-dev-runtime");
const reactDom = require("react-dom");
const reactDomClient = require("react-dom/client");

mock.module("react", () => react);
mock.module("react/jsx-runtime", () => jsxRuntime);
mock.module("react/jsx-dev-runtime", () => jsxDevRuntime);
mock.module("react-dom", () => reactDom);
mock.module("react-dom/client", () => reactDomClient);
