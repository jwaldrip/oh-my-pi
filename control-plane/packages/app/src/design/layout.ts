/**
 * The one breakpoint.
 *
 * Five platforms, one question: is there room for the bay and a log at the same
 * time. Everything else about the layout follows from flexbox, and a table of
 * device classes would be five ways to be wrong about a window a person can
 * resize.
 */

import { useWindowDimensions } from "react-native";

/** Width at which the bay and a log are on screen together. */
export const SPLIT_WIDTH = 860;

export function useSplitLayout(): boolean {
  const { width } = useWindowDimensions();
  return width >= SPLIT_WIDTH;
}
