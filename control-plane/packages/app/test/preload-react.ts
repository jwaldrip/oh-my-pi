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

const require = createRequire(new URL("../../../../package.json", import.meta.url));

// React Native Web is hoisted to this workspace root, so resolve every piece
// of the test render stack from the same package boundary it sees.
const react = require("react");
const jsxRuntime = require("react/jsx-runtime");
const jsxDevRuntime = require("react/jsx-dev-runtime");
const reactDom = require("react-dom");
const reactDomServer = require("react-dom/server");
const reactDomClient = require("react-dom/client");

mock.module("react", () => react);
mock.module("react/jsx-runtime", () => jsxRuntime);
mock.module("react/jsx-dev-runtime", () => jsxDevRuntime);
mock.module("react-dom", () => reactDom);
mock.module("react-dom/client", () => reactDomClient);
mock.module("react-dom/server", () => reactDomServer);
