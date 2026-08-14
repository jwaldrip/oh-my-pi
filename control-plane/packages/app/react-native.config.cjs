/**
 * Platform registry for the community CLI.
 *
 * iOS and Android use the hosts in `ios/` and `android/`. macOS and Windows
 * remain dependency-only until their native projects exist. This file is
 * CommonJS because the React Native CLI loads it that way, and the app package
 * declares `"type": "module"`.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
  },
  assets: ["./src/design/fonts"],
};
