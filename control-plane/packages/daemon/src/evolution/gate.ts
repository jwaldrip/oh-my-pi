/**
 * The safety boundary of the evolution loop.
 *
 * A self-improving control plane that can rewrite its own safety rules has no
 * safety rules. This module is the one place that decides whether a proposal is
 * allowed to enter the pipeline at all, so it is deliberately the most paranoid
 * file in the package.
 *
 * Three properties are load-bearing:
 *
 * 1. **Paths come from the diff, never from the proposal.** `Proposal.touchedPaths`
 *    is a claim by the author of the diff. A proposal that under-reports its own
 *    paths is precisely the attack, so the claim is recorded for audit and then
 *    ignored. Everything protective reads paths parsed out of the unified diff.
 *
 * 2. **A malformed diff is rejected, never best-effort parsed.** Guessing at a
 *    diff the parser does not fully understand is how a protected path slips
 *    through in a section the parser skipped. Hunk bodies are consumed by the
 *    line counts declared in their `@@` headers, which is the only way to tell a
 *    removed line beginning `-- ` from a real `--- ` file header.
 *
 * 3. **There is no configuration.** `evaluateProposal` takes one argument and
 *    returns a verdict. It has no options object, no policy hook, and no
 *    auto-promote switch, because a setting that can remove the gate is a way to
 *    remove the gate.
 *
 * The function is pure and total: no I/O, no clock, no throw.
 */

import { isProtectedPath, type Proposal, type ProposalState } from "@ompd/core";

/**
 * `accepted` means only that the diff is well formed and touches nothing
 * protected. It is not an endorsement of the change, which still has to survive
 * evaluation in an isolated worktree and then an operator.
 */
export type GateOutcome = "accepted" | "archived" | "malformed";

export interface GateVerdict {
  outcome: GateOutcome;
  /** The state the proposal must be persisted with. Callers do not get a say. */
  nextState: ProposalState;
  /** Repo-relative POSIX paths derived from the diff itself. */
  touchedPaths: string[];
  /** The subset of `touchedPaths` that is protected. Empty unless archived. */
  protectedPaths: string[];
  reason: string;
}

interface DiffSection {
  /** Text following `diff --git `, retained only for metadata-only sections. */
  headerRemainder: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  hunks: number;
  /** Set by `new file mode` / `deleted file mode` / `old mode` / `new mode`. */
  metadataOnlyValid: boolean;
}

interface ParseFailure {
  ok: false;
  reason: string;
}

interface ParseSuccess {
  ok: true;
  /** Paths as they would be written, best identification of the applied path. */
  applied: string[];
  /**
   * Every spelling a path could resolve to under `git apply`, including the
   * `-p1` stripped form. Protection is checked against all of them.
   */
  candidates: string[];
}

type ParseResult = ParseSuccess | ParseFailure;

/** Metadata lines that legitimately appear in a git diff header block. */
const HEADER_KEYWORDS: readonly string[] = [
  "index ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
];

/**
 * The gate. Pure, total, and unconfigurable.
 *
 * `p.touchedPaths` is read for the audit trail and never for a decision.
 */
export function evaluateProposal(p: Proposal): GateVerdict {
  let parsed: ParseResult;
  try {
    parsed = parseUnifiedDiff(p.diff);
  } catch (err) {
    // A parser bug must fail closed rather than crash the daemon. Reaching this
    // branch is itself a defect, but the safe answer is still "no".
    return {
      outcome: "malformed",
      nextState: "rejected",
      touchedPaths: [],
      protectedPaths: [],
      reason: `diff parser failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed.ok) {
    return {
      outcome: "malformed",
      nextState: "rejected",
      touchedPaths: [],
      protectedPaths: [],
      reason: `malformed diff: ${parsed.reason}`,
    };
  }

  const protectedHits: string[] = [];
  for (const candidate of parsed.candidates) {
    if (isProtectedPath(candidate) && !protectedHits.includes(candidate)) {
      protectedHits.push(candidate);
    }
  }

  if (protectedHits.length > 0) {
    return {
      outcome: "archived",
      nextState: "archived",
      touchedPaths: parsed.applied,
      protectedPaths: protectedHits,
      reason: `proposal touches protected ${
        protectedHits.length === 1 ? "path" : "paths"
      }: ${protectedHits.join(", ")}`,
    };
  }

  return {
    outcome: "accepted",
    nextState: "submitted",
    touchedPaths: parsed.applied,
    protectedPaths: [],
    reason: `diff touches ${parsed.applied.length} path(s), none protected`,
  };
}

/**
 * Parse a unified diff into the set of paths it touches.
 *
 * Hunk bodies are consumed by declared line count rather than by sniffing line
 * prefixes. That matters: removing a source line that reads `-- x` emits
 * `--- x`, which is indistinguishable from a file header by prefix alone. Only
 * the `@@` counts disambiguate, and a parser that guesses here can be steered
 * into ignoring a whole file section.
 */
function parseUnifiedDiff(diff: string): ParseResult {
  if (typeof diff !== "string" || diff.trim() === "") {
    return { ok: false, reason: "empty diff" };
  }

  const lines = diff.split("\n");
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.replace(/\r$/, "") ?? "";

    if (inHunk && (oldRemaining > 0 || newRemaining > 0)) {
      // "\ No newline at end of file" annotates the previous line and counts
      // against neither side.
      if (line.startsWith("\\")) continue;

      const marker = line.charAt(0);
      if (marker === "-") {
        if (oldRemaining === 0) return { ok: false, reason: `hunk overruns old side at line ${i + 1}` };
        oldRemaining--;
        continue;
      }
      if (marker === "+") {
        if (newRemaining === 0) return { ok: false, reason: `hunk overruns new side at line ${i + 1}` };
        newRemaining--;
        continue;
      }
      if (marker === " " || line === "") {
        if (oldRemaining === 0 || newRemaining === 0) {
          return { ok: false, reason: `context line overruns hunk at line ${i + 1}` };
        }
        oldRemaining--;
        newRemaining--;
        continue;
      }
      return { ok: false, reason: `unexpected line inside hunk at line ${i + 1}` };
    }

    inHunk = false;

    if (line.startsWith("diff --git ")) {
      current = {
        headerRemainder: line.slice("diff --git ".length),
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        hunks: 0,
        metadataOnlyValid: false,
      };
      sections.push(current);
      continue;
    }

    if (line.startsWith("--- ")) {
      // A plain `diff -u` has no `diff --git` header, so open one implicitly.
      // An existing section that already has both sides also starts a new file.
      if (current === null || (current.oldPath !== null && current.newPath !== null)) {
        current = {
          headerRemainder: null,
          oldPath: null,
          newPath: null,
          renameFrom: null,
          renameTo: null,
          hunks: 0,
          metadataOnlyValid: false,
        };
        sections.push(current);
      }
      if (current.oldPath !== null) {
        return { ok: false, reason: `duplicate '---' header at line ${i + 1}` };
      }
      current.oldPath = headerPath(line.slice(4));
      if (current.oldPath === null) {
        return { ok: false, reason: `unparseable '---' path at line ${i + 1}` };
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (current === null || current.oldPath === null) {
        return { ok: false, reason: `'+++' without a preceding '---' at line ${i + 1}` };
      }
      if (current.newPath !== null) {
        return { ok: false, reason: `duplicate '+++' header at line ${i + 1}` };
      }
      current.newPath = headerPath(line.slice(4));
      if (current.newPath === null) {
        return { ok: false, reason: `unparseable '+++' path at line ${i + 1}` };
      }
      continue;
    }

    if (line.startsWith("@@")) {
      if (current === null) {
        return { ok: false, reason: `hunk at line ${i + 1} precedes any file header` };
      }
      if (current.oldPath === null || current.newPath === null) {
        return { ok: false, reason: `hunk at line ${i + 1} has no '---'/'+++' pair` };
      }
      const counts = parseHunkHeader(line);
      if (counts === null) {
        return { ok: false, reason: `unparseable hunk header at line ${i + 1}` };
      }
      current.hunks++;
      oldRemaining = counts.oldCount;
      newRemaining = counts.newCount;
      inHunk = true;
      continue;
    }

    if (line.startsWith("rename from ")) {
      if (current === null) return { ok: false, reason: `'rename from' outside a file section at line ${i + 1}` };
      current.renameFrom = headerPath(line.slice("rename from ".length));
      current.metadataOnlyValid = true;
      if (current.renameFrom === null) {
        return { ok: false, reason: `unparseable rename source at line ${i + 1}` };
      }
      continue;
    }

    if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      if (current === null) return { ok: false, reason: `rename target outside a file section at line ${i + 1}` };
      const keyword = line.startsWith("rename to ") ? "rename to " : "copy to ";
      current.renameTo = headerPath(line.slice(keyword.length));
      current.metadataOnlyValid = true;
      if (current.renameTo === null) {
        return { ok: false, reason: `unparseable rename target at line ${i + 1}` };
      }
      continue;
    }

    if (line.startsWith("copy from ")) {
      if (current === null) return { ok: false, reason: `'copy from' outside a file section at line ${i + 1}` };
      current.renameFrom = headerPath(line.slice("copy from ".length));
      current.metadataOnlyValid = true;
      if (current.renameFrom === null) {
        return { ok: false, reason: `unparseable copy source at line ${i + 1}` };
      }
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      // Base85 payload lines are indistinguishable from junk, and a binary blob
      // is not a reviewable proposal. Refuse rather than skip to the next
      // section, which is where a hidden file edit would live.
      return { ok: false, reason: `binary patches are not accepted (line ${i + 1})` };
    }

    if (HEADER_KEYWORDS.some((kw) => line.startsWith(kw))) {
      if (current === null) return { ok: false, reason: `file metadata outside a section at line ${i + 1}` };
      current.metadataOnlyValid = true;
      continue;
    }

    // "\ No newline at end of file" trailing the final line of a hunk arrives
    // after the counters have already reached zero, so it lands here rather
    // than in the hunk body. It carries no path either way.
    if (line.startsWith("\\")) continue;

    if (line === "") continue;

    // Anything else before the first section is commit-message or diffstat
    // preamble, which `git apply` also ignores. After a section has opened,
    // unrecognised text means the parser has lost the thread.
    if (current !== null) {
      return { ok: false, reason: `unrecognised line ${i + 1} inside a file section` };
    }
  }

  if (inHunk && (oldRemaining > 0 || newRemaining > 0)) {
    return { ok: false, reason: "truncated hunk: declared line counts were not satisfied" };
  }

  if (sections.length === 0) {
    return { ok: false, reason: "no file sections found" };
  }

  const applied: string[] = [];
  const candidates: string[] = [];

  for (const section of sections) {
    const resolved = resolveSectionPaths(section);
    if (!resolved.ok) return resolved;
    for (const path of resolved.applied) {
      if (!applied.includes(path)) applied.push(path);
    }
    for (const path of resolved.candidates) {
      if (!candidates.includes(path)) candidates.push(path);
    }
  }

  return { ok: true, applied, candidates };
}

/**
 * Work out which paths a single file section touches.
 *
 * Renames contribute both endpoints. A rename *into* a protected path is the
 * obvious bypass, and a rename *out of* one deletes a protected file, so both
 * sides are checked.
 */
function resolveSectionPaths(section: DiffSection): ParseResult {
  const raw: string[] = [];

  if (section.renameFrom !== null || section.renameTo !== null) {
    if (section.renameFrom === null || section.renameTo === null) {
      return { ok: false, reason: "rename section is missing one of its endpoints" };
    }
    raw.push(section.renameFrom, section.renameTo);
  }

  if (section.oldPath !== null || section.newPath !== null) {
    if (section.oldPath === null || section.newPath === null) {
      return { ok: false, reason: "file section has '---' or '+++' but not both" };
    }
    const oldIsNull = section.oldPath === "/dev/null";
    const newIsNull = section.newPath === "/dev/null";
    if (oldIsNull && newIsNull) {
      return { ok: false, reason: "file section maps /dev/null onto /dev/null" };
    }
    if (!oldIsNull) raw.push(section.oldPath);
    if (!newIsNull) raw.push(section.newPath);
  }

  if (raw.length === 0) {
    // No `---`/`+++` and no rename. Only a mode change or a metadata-only
    // section can legitimately look like this, and it still names a file in the
    // `diff --git` header.
    if (!section.metadataOnlyValid || section.headerRemainder === null) {
      return { ok: false, reason: "file section names no path" };
    }
    const fromHeader = splitGitHeaderPaths(section.headerRemainder);
    if (fromHeader === null) {
      return { ok: false, reason: "ambiguous 'diff --git' header with no '---'/'+++' pair" };
    }
    raw.push(...fromHeader);
  }

  if (section.hunks === 0 && !section.metadataOnlyValid) {
    return { ok: false, reason: "file section declares a path but carries no hunks" };
  }

  const applied: string[] = [];
  const candidates: string[] = [];

  for (const value of raw) {
    const stripped = stripSourcePrefix(value);
    const normalized = normalizeRepoPath(stripped);
    if (normalized === null) {
      return { ok: false, reason: `path escapes the repository root: ${value}` };
    }
    applied.push(normalized);
    candidates.push(normalized);

    // `git apply` defaults to `-p1`, which drops the first component whatever
    // it is called. A diff generated with a custom `--src-prefix` would
    // otherwise present `vendored/packages/core/src/policy.ts` and land on the
    // protected file anyway. Checking the stripped form too closes that.
    const slash = stripped.indexOf("/");
    const p1 = slash < 0 ? null : normalizeRepoPath(stripped.slice(slash + 1));
    if (p1 !== null && !candidates.includes(p1)) candidates.push(p1);
  }

  return { ok: true, applied, candidates };
}

/**
 * Extract the path from a `---` / `+++` / `rename` line body.
 *
 * These lines carry exactly one path, which makes them unambiguous even when
 * the name contains spaces. Only a tab-delimited timestamp (from `diff -u`) and
 * C-style quoting need undoing. Returns null when the value cannot be read.
 */
function headerPath(body: string): string | null {
  const tab = body.indexOf("\t");
  const value = tab >= 0 ? body.slice(0, tab) : body;
  if (value === "") return null;

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return null;
    return cUnquote(value);
  }
  return value;
}

/**
 * Undo git's C-style quoting.
 *
 * Octal escapes are emitted per UTF-8 byte and are reassembled here as code
 * units rather than decoded. Every protected path is pure ASCII, where the two
 * coincide, so this cannot make a protected path read as unprotected.
 */
function cUnquote(quoted: string): string | null {
  let out = "";
  for (let i = 1; i < quoted.length - 1; i++) {
    const ch = quoted.charAt(i);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i++;
    const esc = quoted.charAt(i);
    if (esc === "") return null;
    if (esc === "n") {
      out += "\n";
    } else if (esc === "t") {
      out += "\t";
    } else if (esc === "r") {
      out += "\r";
    } else if (esc === '"' || esc === "\\") {
      out += esc;
    } else if (esc >= "0" && esc <= "7") {
      const oct = quoted.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += 2;
    } else {
      return null;
    }
  }
  return out === "" ? null : out;
}

function parseHunkHeader(line: string): { oldCount: number; newCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  const oldCount = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
  const newCount = m[4] === undefined ? 1 : Number.parseInt(m[4], 10);
  if (!Number.isFinite(oldCount) || !Number.isFinite(newCount)) return null;
  return { oldCount, newCount };
}

function stripSourcePrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

/**
 * Reduce a path to repo-relative POSIX form, or null if it is not one.
 *
 * `..` traversal and absolute paths are rejected rather than clamped, because a
 * proposal writing outside the repository is never legitimate and `packages/
 * core/src/foo/../policy.ts` is an obvious way to spell a protected path
 * without matching a prefix check.
 */
function normalizeRepoPath(path: string): string | null {
  const unixed = path.replace(/\\/g, "/");
  if (unixed.startsWith("/")) return null;
  if (/^[A-Za-z]:\//.test(unixed)) return null;

  const out: string[] = [];
  for (const seg of unixed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join("/") : null;
}

/**
 * Split a `diff --git a/x b/y` header into its two paths.
 *
 * Unquoted names containing spaces make this genuinely ambiguous, so it is only
 * used for metadata-only sections that carry no `---`/`+++` pair, and it gives
 * up rather than guess. Ambiguity resolves to null, which the caller turns into
 * a malformed verdict.
 */
function splitGitHeaderPaths(remainder: string): string[] | null {
  if (remainder.startsWith('"')) {
    const close = findClosingQuote(remainder);
    if (close < 0) return null;
    const first = cUnquote(remainder.slice(0, close + 1));
    const rest = remainder.slice(close + 1).trimStart();
    if (first === null || rest === "") return null;
    const second = rest.startsWith('"') ? cUnquote(rest) : rest;
    if (second === null) return null;
    return [first, second];
  }

  const tokens = remainder.split(" ");
  if (tokens.length === 2) {
    return [tokens[0] ?? "", tokens[1] ?? ""];
  }

  // Even token count with matching halves is the only unambiguous reading of a
  // spaced path, and it holds whenever old and new names are equal.
  if (tokens.length % 2 === 0) {
    const half = tokens.length / 2;
    const left = tokens.slice(0, half).join(" ");
    const right = tokens.slice(half).join(" ");
    if (stripSourcePrefix(left) === stripSourcePrefix(right)) {
      return [left, right];
    }
  }
  return null;
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}
