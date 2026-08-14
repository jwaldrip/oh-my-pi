/**
 * Proves the one property that actually matters for a takeover feature: a
 * client presence record left behind by a process that is no longer running
 * must never make a session report as live. A stale record making a dead
 * session look alive is the exact failure mode a takeover UI cannot recover
 * from gracefully -- it would offer to attach to nothing.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive, listLiveClientPresences } from "../../src/sessions/liveness.ts";

const scratch: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writeClientRecord(
  root: string,
  projectHash: string,
  fileName: string,
  record: Record<string, unknown>,
): void {
  const clientsDir = join(root, projectHash, "clients");
  mkdirSync(clientsDir, { recursive: true });
  writeFileSync(join(clientsDir, fileName), JSON.stringify(record));
}

describe("isPidAlive", () => {
  test("the current process's own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("a pid that cannot exist on any system is not alive", () => {
    // PIDs are bounded well under this on every platform this daemon targets.
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });

  test("zero and negative pids are never alive", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe("listLiveClientPresences", () => {
  test("a record naming a genuinely running process is reported live", () => {
    const root = tempRoot("liveness-real-");
    writeClientRecord(root, "hash1", "record.json", {
      pid: process.pid,
      id: `${process.pid}-abc`,
      projectDir: "/some/project",
      sessionId: "session-a",
    });
    const live = listLiveClientPresences(root);
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe("session-a");
  });

  test("a stale record naming a dead pid is excluded, not reported live", () => {
    const root = tempRoot("liveness-stale-");
    writeClientRecord(root, "hash1", "record.json", {
      pid: 2_147_483_647,
      id: "stale-record",
      projectDir: "/some/project",
      sessionId: "session-dead",
    });
    expect(listLiveClientPresences(root)).toEqual([]);
  });

  test("live and stale records both present: only the live one is reported", () => {
    const root = tempRoot("liveness-mixed-");
    writeClientRecord(root, "hash1", "live.json", {
      pid: process.pid,
      id: "live-record",
      projectDir: "/a",
      sessionId: "session-live",
    });
    writeClientRecord(root, "hash2", "stale.json", {
      pid: 2_147_483_647,
      id: "stale-record",
      projectDir: "/b",
      sessionId: "session-dead",
    });
    const live = listLiveClientPresences(root);
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe("session-live");
  });

  test("a malformed record file is dropped rather than treated as evidence of liveness", () => {
    const root = tempRoot("liveness-malformed-");
    const clientsDir = join(root, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(join(clientsDir, "broken.json"), "not json");
    expect(listLiveClientPresences(root)).toEqual([]);
  });

  test("scans across multiple project hash directories", () => {
    const root = tempRoot("liveness-multi-project-");
    writeClientRecord(root, "hashA", "a.json", {
      pid: process.pid,
      id: "a",
      projectDir: "/project-a",
      sessionId: "session-a",
    });
    writeClientRecord(root, "hashB", "b.json", {
      pid: process.pid,
      id: "b",
      projectDir: "/project-b",
      sessionId: "session-b",
    });
    const live = listLiveClientPresences(root);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((r) => r.sessionId))).toEqual(new Set(["session-a", "session-b"]));
  });

  test("a missing run/daemons root returns an empty list rather than throwing", () => {
    expect(listLiveClientPresences("/no/such/run/daemons/root")).toEqual([]);
  });
});

process.on("exit", () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
