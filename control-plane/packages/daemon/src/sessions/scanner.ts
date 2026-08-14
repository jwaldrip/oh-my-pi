/**
 * Filesystem-derived catalog of every OMP session file ever written on this
 * machine, complete where ACP's `session/list` caps at 50.
 *
 * Deliberately cheap per file: the session id and creation time come from the
 * filename alone (no I/O), the title comes from the first line of the JSONL
 * (a bounded, small read regardless of how large the file has grown since),
 * and byte size/mtime come from a single `stat`. Only the message count needs
 * a full read of the file; see `countMessages` and its cache in
 * `session-index.ts`, which is the expensive operation this module otherwise
 * avoids entirely.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

/** `<ISO-with-dashes-for-colons>_<uuid>.jsonl`, e.g. `2026-08-11T01-11-48-090Z_019fee60-2c7a-7000-9fd5-7439c7bf3dd2.jsonl`. */
const SESSION_FILE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-f-]{36})\.jsonl$/;

export interface RawSessionFile {
  id: string;
  path: string;
  flattenedDir: string;
  /** ISO timestamp, reconstructed from the filename. */
  createdAt: string;
  title: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Above this, `countMessages` is not called at all and a session reports a
 * null message count instead. Cost is linear in bytes: this machine's real
 * session tree measured roughly 0.78MB/ms on a warm page cache (a 29.8MB
 * file cost 38.4ms; 151.7MB total cost 245.8ms across 308 files). 50MB is
 * comfortably above every real file observed here while capping any single
 * pathological transcript's contribution to a build at roughly 65ms even at
 * that rate -- and a cold read from a slower disk could still be several
 * times that. Nothing prevents a transcript from reaching hundreds of
 * megabytes, and a background index build stalling on one such file is
 * indistinguishable, to an operator, from the session list being broken; an
 * honest null in one row is the same trade this package already makes for a
 * cwd it cannot decode with confidence.
 */
export const MESSAGE_COUNT_SIZE_CEILING_BYTES = 50 * 1024 * 1024;

/** "2026-08-11T01-11-48-090Z" -> "2026-08-11T01:11:48.090Z". The filename form dashes out `:` and `.` because both are awkward in a path segment on at least one platform this tool supports. */
function isoFromFilenameTimestamp(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(raw);
  if (!match) return raw;
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

/**
 * Read only the first line of a file, bounded to `maxBytes` regardless of the
 * file's total size. A session file can grow past ten megabytes; loading the
 * whole thing to read a title that lives in its first 200 bytes is exactly
 * the I/O this scanner exists to avoid.
 */
function readFirstLine(path: string, maxBytes = 65_536): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const chunkSize = 4096;
    const chunk = Buffer.alloc(chunkSize);
    let collected: Buffer[] = [];
    let collectedLength = 0;
    let position = 0;
    while (collectedLength < maxBytes) {
      const bytesRead = readSync(fd, chunk, 0, chunkSize, position);
      if (bytesRead === 0) break;
      const newlineIdx = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (newlineIdx !== -1) {
        collected.push(chunk.subarray(0, newlineIdx));
        return Buffer.concat(collected).toString("utf8");
      }
      collected.push(Buffer.from(chunk.subarray(0, bytesRead)));
      collectedLength += bytesRead;
      position += bytesRead;
    }
    return collectedLength > 0 ? Buffer.concat(collected).toString("utf8") : null;
  } finally {
    closeSync(fd);
  }
}

/** The header line's `title`, or "" for a malformed, absent, or genuinely empty header. Never throws: a scan of 305 files cannot fail wholesale because one has a corrupt first line. */
function extractTitle(firstLine: string | null): string {
  if (!firstLine) return "";
  try {
    const parsed = JSON.parse(firstLine) as { title?: unknown };
    if (typeof parsed.title === "string") return parsed.title;
  } catch {
    // Malformed header; an empty title is the honest answer, not a thrown scan.
  }
  return "";
}

/**
 * Every session file across every cwd-group directory under `sessionsRoot`.
 * A missing or unreadable root, or a group directory that vanishes mid-scan,
 * degrades that entry to "no sessions" rather than failing the whole scan --
 * the filesystem can change under a background index build at any time.
 */
export function scanSessionFiles(sessionsRoot: string = getSessionsDir()): RawSessionFile[] {
  let groupDirs: string[];
  try {
    groupDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const out: RawSessionFile[] = [];
  for (const flattenedDir of groupDirs) {
    const groupPath = join(sessionsRoot, flattenedDir);
    let fileNames: string[];
    try {
      fileNames = readdirSync(groupPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const fileName of fileNames) {
      const match = SESSION_FILE_RE.exec(fileName);
      if (!match) continue; // Not this naming scheme; skip rather than guess at an id.
      const [, tsRaw, id] = match;
      if (!tsRaw || !id) continue;
      const filePath = join(groupPath, fileName);
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const stat = statSync(filePath);
        mtimeMs = stat.mtimeMs;
        sizeBytes = stat.size;
      } catch {
        continue; // Vanished between readdir and stat.
      }
      out.push({
        id,
        path: filePath,
        flattenedDir,
        createdAt: isoFromFilenameTimestamp(tsRaw),
        title: extractTitle(readFirstLine(filePath)),
        mtimeMs,
        sizeBytes,
      });
    }
  }
  return out;
}

/**
 * Count conversation turns in a session file: `type: "message"` lines whose
 * `message.role` is "user" or "assistant". Tool results, thinking deltas, and
 * bookkeeping events (`model_change`, `title_change`, `custom`,
 * `credential_pin`, ...) are excluded so the count reflects turns a person
 * would recognize as the conversation, not every JSONL line the session ever
 * wrote.
 *
 * Requires reading the whole file -- unavoidable, since messages are
 * interleaved with tool calls and thinking blocks throughout, not confined to
 * a prefix. Measured on this machine's real session tree (308 files, 151.7MB
 * total, largest single file 29.8MB): `scanSessionFiles` alone (metadata plus
 * a bounded title read) took 78ms cold; a full cold `countMessages` pass over
 * every file added 245.8ms on top of that (38.4ms of it the 29.8MB file
 * alone). See `SessionIndex`'s mtime+size cache in `@ompd/core`'s
 * `session_scan_cache` table, which makes every build after the first one a
 * cache hit for message counts instead of a re-read.
 */
export function countMessages(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: { type?: unknown; message?: { role?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === "message") {
      const role = parsed.message?.role;
      if (role === "user" || role === "assistant") count++;
    }
  }
  return count;
}
