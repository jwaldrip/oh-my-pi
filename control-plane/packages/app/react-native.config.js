/**
 * Platform registry for the community CLI.
 *
 * iOS and Android use the hosts in `ios/` and `android/`. macOS and Windows
 * remain dependency-only until their native projects exist. This package is ESM,
 * so this config deliberately uses an ESM default export rather than the CommonJS
 * `module.exports` expected by older React Native templates.
 */
export default {
  project: {
    ios: {},
    android: {},
  },
  assets: ["./src/design/fonts"],
};
