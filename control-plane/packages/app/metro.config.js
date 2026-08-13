import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfig, mergeConfig } from "@react-native/metro-config";

/**
 * The app lives inside the OMP workspace and imports `@ompd/core` from a sibling
 * package. Metro must watch the fork root and resolve its Bun-hoisted modules.
 * This config is ESM because the app package declares `"type": "module"`.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const forkRoot = path.resolve(projectRoot, "..", "..", "..");

const config = {
  projectRoot,
  watchFolders: [forkRoot],
  resolver: {
    nodeModulesPaths: [path.join(projectRoot, "node_modules"), path.join(forkRoot, "node_modules")],
    platforms: ["ios", "android", "macos", "windows", "native"],
  },
};

export default mergeConfig(getDefaultConfig(projectRoot), config);
