import { describe, expect, test } from "bun:test";
import { formatCollabJoinLink, isCollabRoomId } from "../src/hub.ts";

describe("collab universal links", () => {
  test("emits the app-owned universal-link form for a room id", () => {
    expect(formatCollabJoinLink("room_0123456789")).toBe("https://app.ompctl.ai/collab/room_0123456789");
  });

  test("refuses room ids that could change the link path or carry a capability", () => {
    expect(isCollabRoomId("room_0123456789")).toBe(true);
    expect(isCollabRoomId("short")).toBe(false);
    expect(isCollabRoomId("room_0123456789/other")).toBe(false);
    expect(() => formatCollabJoinLink("room_0123456789?token=secret")).toThrow();
  });
});
