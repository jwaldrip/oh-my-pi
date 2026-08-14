/**
 * Platform registry for the community CLI.
 *
 * iOS and Android use the hosts in `ios/` and `android/`. macOS and Windows
 * remain dependency-only until their native projects exist. This file is
 * CommonJS because the React Native CLI loads it that way, and the app package
 * declares `"type": "module"`.
 * iOS and Android come from `react-native` itself and need no entry here; their
 * host projects are in `ios/` and `android/`. macOS is an out-of-tree platform,
 * so its explicit entry activates `react-native-macos`'s project discovery for
 * the generated `macos/` host.
 *
 * Windows remains unlisted because its host project has not been generated.
 * The Windows CLI shells out to `npm install`, which refuses to run inside this
 * Bun workspace (`ENOWORKSPACES`).
 *
 * `assets` is what links the vendored typefaces into a native build. Without it
 * Archivo and IBM Plex Mono exist in the repository and nowhere on a device, and
 * the native targets silently fall back to the system face.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
    macos: {},
  },
  assets: ["./src/design/fonts"],
};
