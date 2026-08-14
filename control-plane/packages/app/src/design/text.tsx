/**
 * Typographic primitives.
 *
 * React Native has one `Text` and no notion of a heading, so a scale that lives
 * only in `StyleSheet` calls scattered across twenty components is a scale that
 * drifts within a week. These components are the scale: a surface says what a
 * line of text is for, and the ramp is applied once, here.
 *
 * Colour is a prop rather than a variant because the same role appears in
 * several signal colours: an agent's name is a title whether it is running or
 * has failed, and only its state colour changes.
 */

import type { JSX, ReactNode } from "react";
import { Text } from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import { ink, type } from "./tokens.ts";

interface LineProps {
  children: ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Marks a line as a heading for assistive technology on every platform. */
  heading?: boolean;
  testID?: string;
}

/** Section kickers. Always upper case, because the tracking assumes it. */
export function Kicker({ children, color = ink.muted, style, testID }: LineProps): JSX.Element {
  return (
    <Text testID={testID} style={[type.kicker, { color, textTransform: "uppercase" }, style]}>
      {children}
    </Text>
  );
}

export function Label({ children, color = ink.plain, style, numberOfLines, testID }: LineProps): JSX.Element {
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[type.label, { color }, style]}>
      {children}
    </Text>
  );
}

export function Body({ children, color = ink.bright, style, numberOfLines, testID }: LineProps): JSX.Element {
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[type.body, { color }, style]}>
      {children}
    </Text>
  );
}

export function Title({
  children,
  color = ink.bright,
  style,
  numberOfLines,
  heading,
  testID,
}: LineProps): JSX.Element {
  return (
    <Text
      testID={testID}
      accessibilityRole={heading === true ? "header" : undefined}
      numberOfLines={numberOfLines}
      style={[type.title, { color }, style]}
    >
      {children}
    </Text>
  );
}

export function Display({ children, color = ink.bright, style, heading, testID }: LineProps): JSX.Element {
  return (
    <Text
      testID={testID}
      accessibilityRole={heading === true ? "header" : undefined}
      style={[type.display, { color }, style]}
    >
      {children}
    </Text>
  );
}

/** A number a person compares against another number. Monospaced, always. */
export function Data({ children, color = ink.bright, style, numberOfLines, testID }: LineProps): JSX.Element {
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[type.data, { color }, style]}>
      {children}
    </Text>
  );
}

/** Command output and paths, where column alignment carries meaning. */
export function Code({ children, color = ink.plain, style, numberOfLines, testID }: LineProps): JSX.Element {
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[type.code, { color }, style]}>
      {children}
    </Text>
  );
}
