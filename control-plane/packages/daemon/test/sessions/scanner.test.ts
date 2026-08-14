/**
 * `scanSessionFiles` and `countMessages` are pure filesystem readers; the
 * fixture below writes fake `.jsonl` session files in the exact shape a real
 * OMP session takes (a title header line, a `session` line, and interleaved
 * `message`/`custom`/`model_change` lines) rather than a simplified stand-in,
 * so `countMessages`'s exclusion rules are exercised against the real event
 * vocabulary.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countMessages, scanSessionFiles } from "../../src/sessions/scanner.ts";

const scratch: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writeSessionFile(
  groupDir: string,
  filenameTimestamp: string,
  id: string,
  lines: unknown[],
): string {
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return filePath;
}

const SESSION_ID_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_ID_B = "019feebf-6449-7000-9474-a2ae1f871930";

describe("scanSessionFiles", () => {
  test("finds sessions across multiple cwd-group directories", () => {
    const root = tempRoot("scanner-multi-group-");
    writeSessionFile(join(root, "-Downloads"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "Convert manuscript", source: "auto", updatedAt: "2026-08-11T01:17:41.394Z" },
      { type: "session", version: 3, id: SESSION_ID_A, timestamp: "2026-08-11T01:11:48.090Z", cwd: "/Users/x/Downloads" },
    ]);
    writeSessionFile(join(root, "--private-tmp--"), "2026-08-13T01-44-21-962Z", SESSION_ID_B, [
      { type: "title", v: 1, title: "", updatedAt: "2026-08-13T01:44:21.962Z" },
      { type: "session", version: 3, id: SESSION_ID_B, timestamp: "2026-08-13T01:44:21.962Z", cwd: "/tmp" },
    ]);

    const files = scanSessionFiles(root);
    expect(files).toHaveLength(2);
    const groups = new Set(files.map((f) => f.flattenedDir));
    expect(groups).toEqual(new Set(["-Downloads", "--private-tmp--"]));
  });

  test("derives id and createdAt from the filename alone, not file contents", () => {
    const root = tempRoot("scanner-filename-derived-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "hi", updatedAt: "2026-08-11T01:11:48.090Z" },
    ]);
    const [file] = scanSessionFiles(root);
    expect(file).toBeDefined();
    expect(file!.id).toBe(SESSION_ID_A);
    expect(file!.createdAt).toBe("2026-08-11T01:11:48.090Z");
  });

  test("reads title from the header line without a message line present", () => {
    const root = tempRoot("scanner-title-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "Build the thing", updatedAt: "2026-08-11T01:11:48.090Z" },
    ]);
    const [file] = scanSessionFiles(root);
    expect(file!.title).toBe("Build the thing");
  });

  test("an empty title header degrades to an empty string, not a throw", () => {
    const root = tempRoot("scanner-empty-title-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "" },
    ]);
    const files = scanSessionFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.title).toBe("");
  });

  test("a malformed header line degrades to an empty title instead of failing the scan", () => {
    const root = tempRoot("scanner-malformed-header-");
    const groupDir = join(root, "-x");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, `2026-08-11T01-11-48-090Z_${SESSION_ID_A}.jsonl`), "not json\nmore\n");
    const files = scanSessionFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.title).toBe("");
  });

  test("ignores non-jsonl entries and the per-session artifact subdirectories real OMP writes alongside a transcript", () => {
    const root = tempRoot("scanner-ignore-non-jsonl-");
    const groupDir = join(root, "-x");
    writeSessionFile(groupDir, "2026-08-11T01-11-48-090Z", SESSION_ID_A, [{ type: "title", v: 1, title: "t" }]);
    // Real OMP leaves a same-named directory next to the .jsonl for subagent
    // artifacts; it must never be mistaken for a second session.
    mkdirSync(join(groupDir, `2026-08-11T01-11-48-090Z_${SESSION_ID_A}`), { recursive: true });
    writeFileSync(join(groupDir, "not-a-session.txt"), "junk");
    const files = scanSessionFiles(root);
    expect(files).toHaveLength(1);
  });

  test("byte size and mtime come from stat, matching the real file", () => {
    const root = tempRoot("scanner-stat-");
    const path = writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "t" },
    ]);
    const mtime = new Date("2026-08-11T05:00:00.000Z");
    utimesSync(path, mtime, mtime);
    const [file] = scanSessionFiles(root);
    expect(file!.sizeBytes).toBeGreaterThan(0);
    expect(Math.abs(file!.mtimeMs - mtime.getTime())).toBeLessThan(1000);
  });

  test("a missing sessions root returns an empty list rather than throwing", () => {
    expect(scanSessionFiles("/no/such/sessions/root/anywhere")).toEqual([]);
  });
});

describe("countMessages", () => {
  test("counts user and assistant turns, excluding tool results and bookkeeping events", () => {
    const root = tempRoot("scanner-count-");
    const path = writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "t" },
      { type: "session", version: 3, id: SESSION_ID_A, timestamp: "t", cwd: "/x" },
      { type: "model_change", id: "a", model: "m" },
      { type: "thinking_level_change", id: "b", thinkingLevel: "off" },
      { type: "message", id: "c", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "title_change", id: "d", title: "t2" },
      { type: "message", id: "e", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
      { type: "custom", customType: "tool_execution_start", id: "f", data: {} },
      { type: "message", id: "g", message: { role: "toolResult", toolCallId: "x", content: [] } },
      { type: "credential_pin", id: "h", provider: "p", hash: "x" },
      { type: "message", id: "i", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    ]);
    expect(countMessages(path)).toBe(3);
  });

  test("a missing file counts zero rather than throwing", () => {
    expect(countMessages("/no/such/file.jsonl")).toBe(0);
  });

  test("skips malformed lines without losing the rest of the count", () => {
    const root = tempRoot("scanner-count-malformed-");
    const groupDir = join(root, "-x");
    mkdirSync(groupDir, { recursive: true });
    const path = join(groupDir, `2026-08-11T01-11-48-090Z_${SESSION_ID_A}.jsonl`);
    const lines = [
      JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [] } }),
      "not valid json at all",
      JSON.stringify({ type: "message", id: "b", message: { role: "assistant", content: [] } }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    expect(countMessages(path)).toBe(2);
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
