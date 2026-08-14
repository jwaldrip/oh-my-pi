import { defineConfig } from "vite";

/**
 * The client imports wire contracts straight from `@ompd/core`'s source rather
 * than through the package entry point, because that entry re-exports the
 * SQLite store and would drag `bun:sqlite` into a browser bundle. Only
 * `contracts.ts` is reachable from here, and it is dependency-free.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    // A control plane console is small by construction. If a chunk crosses
    // this line something has been pulled in that does not belong in a phone.
    chunkSizeWarningLimit: 120,
  },
  server: {
    port: 5173,
    fs: {
      // Dev-server reads of the sibling contracts module.
      allow: [".", "../core/src"],
    },
  },
});
