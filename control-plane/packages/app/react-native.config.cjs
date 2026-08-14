/**
 * Platform registry for the community CLI.
 *
 * iOS and Android come from `react-native` itself and use the host projects in
 * `ios/` and `android/`. macOS and Windows are out-of-tree platforms, so their
 * explicit entries activate project discovery for the generated native hosts.
 *
 * `assets` links the vendored typefaces into native builds. Without it, Archivo
 * and IBM Plex Mono exist in the repository and nowhere on a device.
 * This file is CommonJS because the React Native CLI loads it that way, while
 * the app package declares `"type": "module"`.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
    macos: {},
    windows: {},
  },
  assets: ["./src/design/fonts"],
};
