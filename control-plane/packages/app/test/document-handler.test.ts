import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@ompd/core/contracts";
import type { Connection } from "../src/platform/connection.ts";
import { bootOpenedOmpSession, isOmpSessionDocument } from "../src/platform/document-handler.ts";

const sessionId = "019ab4fa-1567-7fae-8000-000000000001";
const direct: Connection = {
  transport: "direct",
  url: "wss://daemon.example.test/v1/socket",
  token: "paired-token",
  scopes: ["read"],
};
const liveSession: SessionSummary = {
  id: sessionId,
  cwd: "/work/project",
  cwdScope: "abs",
  flattenedDir: "work-project",
  title: "The test is the boundary",
  createdAt: "2026-08-13T10:00:00.000Z",
  lastActivityAt: "2026-08-13T10:00:00.000Z",
  messageCount: 8,
  byteSize: 1200,
  status: "live-ompd",
  archived: false,
  agentId: "agt_0000000000000001",
};

const openedDocument = {
  name: "project-handoff.ompsession",
  text: JSON.stringify({
    version: "1.0",
    sessionId,
    handoffMarkdown: "# Handoff\n\nThe test is the boundary.",
    activeModel: "anthropic/claude-sonnet-5",
    daemonHint: "wss://daemon.example.test/v1/socket",
  }),
};

describe(".ompsession document boot", () => {
  test("uses the paired target daemon, looks up the session id, and attaches its live agent", async () => {
    const requested: Connection[] = [];
    const selected: string[] = [];
    const handoffs: unknown[] = [];

    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => openedDocument,
        loadConnection: async () => direct,
        listSessions: async (connection) => {
          requested.push(connection);
          return [liveSession];
        },
        selectAgent: (agentId) => {
          selected.push(agentId);
        },
        onHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      }),
    ).resolves.toEqual({ status: "resumed", sessionId });

    expect(requested).toEqual([direct]);
    expect(selected).toEqual(["agt_0000000000000001"]);
    expect(handoffs).toEqual([
      {
        version: "1.0",
        sessionId,
        handoffMarkdown: "# Handoff\n\nThe test is the boundary.",
        activeModel: "anthropic/claude-sonnet-5",
        daemonHint: "wss://daemon.example.test/v1/socket",
      },
    ]);
  });

  test("uses the existing paired daemon when the portable boundary omits a hint", async () => {
    const selected: string[] = [];
    const text = JSON.stringify({ ...JSON.parse(openedDocument.text), daemonHint: undefined });

    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => ({ ...openedDocument, text }),
        loadConnection: async () => direct,
        listSessions: async () => [liveSession],
        selectAgent: (agentId) => {
          selected.push(agentId);
        },
      }),
    ).resolves.toEqual({ status: "resumed", sessionId });

    expect(selected).toEqual(["agt_0000000000000001"]);
  });

  test("refuses to connect a handoff to a different daemon without a pairing for it", async () => {
    let listed = false;
    const text = JSON.stringify({ ...JSON.parse(openedDocument.text), daemonHint: "wss://other.example.test/v1/socket" });

    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => ({ ...openedDocument, text }),
        loadConnection: async () => direct,
        listSessions: async () => {
          listed = true;
          return [liveSession];
        },
        selectAgent: () => {},
      }),
    ).resolves.toEqual({ status: "daemon-mismatch", daemonHint: "wss://other.example.test/v1/socket" });

    expect(listed).toBeFalse();
  });

  test("does not turn a document into a connection when this device is not paired", async () => {
    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => openedDocument,
        loadConnection: async () => null,
        listSessions: async () => {
          throw new Error("must not list sessions without a paired daemon");
        },
        selectAgent: () => {},
      }),
    ).resolves.toEqual({ status: "pairing-required", daemonHint: "wss://daemon.example.test/v1/socket" });
  });

  test("reports a dormant or unknown session instead of attaching an arbitrary agent", async () => {
    let selected = false;
    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => openedDocument,
        loadConnection: async () => direct,
        listSessions: async () => [{ ...liveSession, status: "dormant", agentId: undefined }],
        selectAgent: () => {
          selected = true;
        },
      }),
    ).resolves.toEqual({ status: "session-unavailable", sessionId });
    expect(selected).toBeFalse();
  });

  test("ignores non-session documents without reading pairing state", async () => {
    let loaded = false;
    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => ({ name: "notes.md", text: "# notes" }),
        loadConnection: async () => {
          loaded = true;
          return direct;
        },
        listSessions: async () => [liveSession],
        selectAgent: () => {},
      }),
    ).resolves.toEqual({ status: "ignored" });
    expect(loaded).toBeFalse();
  });

  test("reports an invalid handoff without listing or attaching a session", async () => {
    let listed = false;
    await expect(
      bootOpenedOmpSession({
        readInitialDocument: async () => ({ name: "bad.ompsession", text: "not json" }),
        loadConnection: async () => direct,
        listSessions: async () => {
          listed = true;
          return [liveSession];
        },
        selectAgent: () => {},
      }),
    ).resolves.toEqual({ status: "invalid" });
    expect(listed).toBeFalse();
  });

  test("recognizes file URLs and case-insensitive session filenames", () => {
    expect(isOmpSessionDocument("file:///private/tmp/PROJECT.OMPSESSION?provider=files")).toBeTrue();
    expect(isOmpSessionDocument("file:///private/tmp/project.md")).toBeFalse();
  });
});
