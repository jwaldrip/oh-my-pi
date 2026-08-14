/**
 * A tool call, as a card.
 *
 * A tool call is the only entry in the timeline that changes after it appears:
 * announced pending, amended in progress, settled completed or failed. So the
 * card is built around the one thing that moves, the status rail down its left
 * edge, and everything else holds still under it. Nothing here animates; a
 * colour changing under a stationary title is legible at a glance and a card
 * that slides is not.
 *
 * Output is clamped rather than scrollable. A nested scroll region inside a
 * scrolling transcript is a trap on a touch screen, and the operator who wants
 * the whole of a 4000-line build log wants it on the machine running the build.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { shortenPath } from "../design/format.ts";
import { Glyph, TOOL_GLYPHS } from "../design/icons.tsx";
import { Code, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, toolSignal } from "../design/tokens.ts";
import type { ToolEntry } from "../session/model.ts";

/** Lines of output shown before the card asks to be opened. */
const CLAMP_LINES = 6;

export function ToolCard({ entry }: { entry: ToolEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const tone = signal[toolSignal(entry.status)];
  const glyph = TOOL_GLYPHS[entry.toolKind] ?? "other";
  const output = entry.output;
  const lines = output === null ? 0 : output.split("\n").length;
  const clamped = !open && lines > CLAMP_LINES;

  return (
    <View style={styles.card} testID={`tool-${entry.id}`}>
      <View style={[styles.rail, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <View style={styles.head}>
          <Glyph name={glyph} size={13} color={tone} />
          <Title numberOfLines={2} style={styles.title} testID={`tool-title-${entry.id}`}>
            {entry.title}
          </Title>
          <Kicker color={tone} testID={`tool-status-${entry.id}`}>
            {entry.status.replace("_", " ")}
          </Kicker>
        </View>

        {entry.locations.length > 0 ? (
          <View style={styles.locations}>
            {entry.locations.slice(0, 4).map((path) => (
              <Label key={path} color={ink.muted} numberOfLines={1}>
                {shortenPath(path, 2)}
              </Label>
            ))}
            {entry.locations.length > 4 ? (
              <Label color={ink.faint}>{`+${entry.locations.length - 4} more`}</Label>
            ) : null}
          </View>
        ) : null}

        {output !== null && output.length > 0 ? (
          <View style={styles.output}>
            <Code numberOfLines={clamped ? CLAMP_LINES : undefined} testID={`tool-output-${entry.id}`}>
              {output}
            </Code>
            {lines > CLAMP_LINES ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={open ? "Collapse output" : `Show all ${lines} lines`}
                onPress={() => {
                  setOpen(!open);
                }}
                style={styles.more}
              >
                <Glyph name="chevron" size={10} color={ink.muted} />
                <Label color={ink.muted}>{open ? "collapse" : `${lines} lines`}</Label>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  rail: { width: 3 },
  body: { flex: 1, padding: space.step, gap: space.snug },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.snug },
  title: { flex: 1 },
  locations: { gap: space.hair, paddingLeft: space.wide + space.tight },
  output: {
    backgroundColor: ground.base,
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.edge,
    padding: space.snug,
    gap: space.tight,
  },
  more: { flexDirection: "row", alignItems: "center", gap: space.tight, paddingTop: space.tight },
});
