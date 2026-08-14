/**
 * Web entry.
 *
 * `AppRegistry.runApplication` rather than `createRoot` directly: react-native-web
 * installs the style sheet and the responder system as part of running an
 * application, and mounting the tree past it produces a page where `Pressable`
 * never fires and every `StyleSheet` rule is missing.
 */

import { AppRegistry } from "react-native";
import { App } from "./App.tsx";
import { name } from "../app.json";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

AppRegistry.registerComponent(name, () => App);
AppRegistry.runApplication(name, { rootTag: root });
