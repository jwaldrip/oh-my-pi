/**
 * Where a skill or connector came from, as a small badge.
 *
 * Origin is not a seventh signal colour — the six signals in `design/tokens`
 * mean state, and provenance is a different axis that would compete with
 * whatever state colour is sitting right next to it (a connector's own
 * connected/down bar, a task's own running/waiting bar). This distinguishes
 * native, marketplace, and local by icon and by material instead — the same
 * `ground` vocabulary that already gives the app depth: `active` for the
 * org's own (held, foregrounded), `raised` for an installed plugin (a card
 * sitting on a panel), a bare dashed line for local, unpackaged content.
 */

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import type { PluginOrigin } from "../cowork/catalog.ts";
import { ORIGIN_LABELS } from "../cowork/catalog.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, space, stroke } from "../design/tokens.ts";

const ORIGIN_GLYPHS: Record<PluginOrigin, GlyphName> = {
  native: "native",
  marketplace: "marketplace",
  local: "folder",
};

const ORIGIN_TONES: Record<PluginOrigin, string> = {
  native: ink.bright,
  marketplace: ink.plain,
  local: ink.muted,
};

export interface PluginBadgeProps {
  origin: PluginOrigin;
  /** The plugin or provider's own label — "cld", "Claude Code Marketplace". */
  label: string;
  testID?: string;
}

export function PluginBadge({ origin, label, testID }: PluginBadgeProps): JSX.Element {
  const tone = ORIGIN_TONES[origin];
  return (
    <View
      testID={testID}
      accessibilityLabel={`${ORIGIN_LABELS[origin]}: ${label}`}
      style={[styles.badge, ORIGIN_STYLES[origin]]}
    >
      <Glyph name={ORIGIN_GLYPHS[origin]} size={10} color={tone} />
      <Label color={tone} numberOfLines={1} testID={testID ? `${testID}-label` : undefined}>
        {label}
      </Label>
    </View>
  );
}

const ORIGIN_STYLES = StyleSheet.create({
  native: { backgroundColor: ground.active, borderColor: ground.edge },
  marketplace: { backgroundColor: ground.raised, borderColor: ground.line },
  local: { backgroundColor: "transparent", borderColor: ground.line, borderStyle: "dashed" },
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderWidth: stroke.hair,
    alignSelf: "flex-start",
  },
});
