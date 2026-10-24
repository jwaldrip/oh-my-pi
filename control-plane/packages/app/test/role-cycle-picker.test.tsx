import "./rnw.ts";

import { describe, expect, test } from "bun:test";

const { ROLE_CYCLE, RoleCyclePicker, nextRole } = await import("../src/components/RoleCyclePicker.tsx");

describe("RoleCyclePicker", () => {
  test("cycles default, smol, slow, and plan in both directions", () => {
    expect(ROLE_CYCLE).toEqual(["default", "smol", "slow", "plan"]);
    expect(nextRole("default", 1)).toBe("smol");
    expect(nextRole("smol", 1)).toBe("slow");
    expect(nextRole("slow", 1)).toBe("plan");
    expect(nextRole("plan", 1)).toBe("default");
    expect(nextRole("default", -1)).toBe("plan");
  });

  test("exposes the selected role and both controls without relying on a DOM renderer", () => {
    const picker = RoleCyclePicker({ value: "slow", onChange: () => {} });

    expect(picker.props.testID).toBe("role-cycle-picker");
    expect(picker.props.children).toHaveLength(3);
  });
});
