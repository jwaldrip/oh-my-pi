/**
 * The web target.
 *
 * Vite rather than Metro, because a browser wants an ES module graph and a
 * Metro bundle is neither that nor debuggable in devtools. The three settings
 * below are what turn a React Native source tree into one:
 *
 *  - `react-native` resolves to `react-native-web`, which is the whole trick.
 *  - `.web.*` wins over the bare extension, so a platform file is picked up the
 *    same way Metro picks up `.ios.tsx`.
 *  - `__DEV__` exists, because React Native's own modules read it and a browser
 *    has never heard of it.
 *
 * `optimizeDeps.esbuildOptions.loader` covers the dependencies that ship
 * untranspiled Flow-free JSX in `.js` files, which esbuild otherwise parses as
 * plain JavaScript and rejects at the first angle bracket.
 */

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webNodeModules = ["react-native-web", "react-native-svg", "@fortawesome/react-native-fontawesome"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      {
        // react-native-svg ships a browser build beside its native one but does
        // not declare it in `exports`, so the bundler has to be told.
        find: /^react-native-svg$/,
        replacement: fileURLToPath(
          new URL("../../../node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js", import.meta.url),
        ),
      },
    ],
    extensions: [".web.tsx", ".web.ts", ".web.jsx", ".web.js", ".tsx", ".ts", ".jsx", ".js", ".json"],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
    global: "globalThis",
  },
  optimizeDeps: {
    include: webNodeModules,
    esbuildOptions: { loader: { ".js": "jsx" }, resolveExtensions: [".web.js", ".js", ".ts", ".tsx"] },
  },
  build: { outDir: "dist", sourcemap: true },
});
