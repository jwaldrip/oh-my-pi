import { describe, expect, test } from "bun:test";
import {
  OmpSessionFormatError,
  parseOmpSession,
  serializeOmpSession,
  type OmpSessionContainer,
} from "../src/handoff-container.ts";

const handoff: OmpSessionContainer = {
  version: "1.0",
  sessionId: "ses_01H",
  handoffMarkdown: "# Handoff\n\nContinue the migration from the failing test.",
  activeModel: "anthropic/claude-sonnet-5",
  daemonHint: "wss://hub.example.test",
};

describe(".ompsession container", () => {
  test("serializes the versioned boundary without omitting its handoff", () => {
    expect(serializeOmpSession(handoff)).toBe(
      '{"version":"1.0","sessionId":"ses_01H","handoffMarkdown":"# Handoff\\n\\nContinue the migration from the failing test.","activeModel":"anthropic/claude-sonnet-5","daemonHint":"wss://hub.example.test"}',
    );
  });

  test("round-trips every defined field", () => {
    expect(parseOmpSession(serializeOmpSession(handoff))).toEqual(handoff);
  });

  test("accepts a handoff with no daemon hint", () => {
    expect(
      parseOmpSession(
        '{"version":"1.0","sessionId":"ses_01H","handoffMarkdown":"# Handoff","activeModel":"anthropic/claude-sonnet-5"}',
      ),
    ).toEqual({
      version: "1.0",
      sessionId: "ses_01H",
      handoffMarkdown: "# Handoff",
      activeModel: "anthropic/claude-sonnet-5",
    });
  });
  test.each([
    "not json",
    "[]",
    '{"version":"2.0","sessionId":"ses_01H","handoffMarkdown":"# Handoff","activeModel":"model"}',
    '{"version":"1.0","sessionId":"","handoffMarkdown":"# Handoff","activeModel":"model"}',
    '{"version":"1.0","sessionId":"ses_01H","handoffMarkdown":4,"activeModel":"model"}',
    '{"version":"1.0","sessionId":"ses_01H","handoffMarkdown":"# Handoff","activeModel":"","daemonHint":"wss://hub.example.test"}',
    '{"version":"1.0","sessionId":"ses_01H","handoffMarkdown":"# Handoff","activeModel":"model","daemonHint":""}',
  ])("refuses malformed input: %s", (input) => {
    expect(() => parseOmpSession(input)).toThrow(OmpSessionFormatError);
  });
});
