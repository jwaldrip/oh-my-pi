/**
 * `react-native-web` ships no type declarations of its own: consumers are meant
 * to alias `react-native` onto it and use React Native's types, which is what
 * the app does and what `tsconfig` sees.
 *
 * The test harness is the one place that imports it under its real name, in
 * order to substitute it, and there it is a module of components rather than a
 * typed API. Declaring it here keeps `noImplicitAny` on everywhere else.
 */
declare module "react-native-web";
