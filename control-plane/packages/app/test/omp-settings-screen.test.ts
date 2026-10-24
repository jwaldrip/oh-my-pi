import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { OmpSettingsValues } from "@ompd/core";

const { changedSettings } = await import("../src/screens/OmpSettingsScreen.tsx");

describe("OMP settings editor", () => {
  test("posts only values changed from the daemon snapshot", () => {
    const snapshot: OmpSettingsValues = {
      modelRoleStorage: "global",
      "providers.maxInFlightRequests": { openai: 2 },
    };
    const edited: OmpSettingsValues = {
      modelRoleStorage: "project",
      "providers.maxInFlightRequests": { openai: 2 },
    };

    expect(changedSettings(snapshot, edited)).toEqual({ modelRoleStorage: "project" });
  });
});
