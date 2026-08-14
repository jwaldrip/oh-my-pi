/**
 * Native entry. iOS, Android, macOS, and Windows all boot through this file:
 * the platform's host view looks up the component registered under the name in
 * `app.json`, and there is exactly one for all four.
 *
 * Web does not come through here. Vite serves `index.html`, which loads
 * `src/index.web.tsx`, because a Metro bundle is not what a browser wants and
 * `AppRegistry.runApplication` needs a DOM node to be handed.
 */

import { AppRegistry } from "react-native";
import { App } from "./src/App.tsx";
import { name } from "./app.json";

AppRegistry.registerComponent(name, () => App);
