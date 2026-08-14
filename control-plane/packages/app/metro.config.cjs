const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * The app lives inside the OMP workspace and imports `@ompd/core` from a sibling
 * package. Metro must watch the fork root and resolve its Bun-hoisted modules.
 *
 * This file is CommonJS (`.cjs`) because the React Native CLI loads config
 * through a CJS path, and the app package declares `"type": "module"`.
 *
 * `disableHierarchicalLookup` is load-bearing for native. Without it, Metro
 * walks up from a file under the fork-root `node_modules/react-native` and
 * finds the workspace's React 19.2.7 before the app-local 19.1.4 that matches
 * RN 0.81.6's embedded renderer. Two React copies produce the redbox the
 * device hit: "Incompatible React versions: ... 19.2.7 ... renderer 19.1.4".
 * With hierarchical lookup off, only `nodeModulesPaths` is consulted, so the
 * app pin wins for every import including the ones inside react-native itself.
 */
const projectRoot = __dirname;
const forkRoot = path.resolve(projectRoot, "..", "..", "..");

const config = {
  projectRoot,
  watchFolders: [forkRoot],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(projectRoot, "node_modules"), path.join(forkRoot, "node_modules")],
    /**
     * One tree, several platforms. `web` is served by Vite rather than Metro,
     * but keeping it in the list means a `.web.tsx` sibling is never picked up
     * by a native bundle by accident.
     */
    platforms: ["ios", "android", "macos", "windows", "native"],
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
