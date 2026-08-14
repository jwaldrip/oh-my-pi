/**
 * Reverses the flattened session directory names OMP writes under
 * `~/.omp/agent/sessions/<flattened-cwd>/`, so the daemon can group sessions
 * by their real working directory.
 *
 * Mirrors the three encoding schemes in
 * `packages/coding-agent/src/session/session-paths.ts`
 * (`encodeRelativeSessionDirName`, `encodeLegacyAbsoluteSessionDirName`,
 * `getDefaultSessionDirName`), which are private to that module and not
 * exported. Reimplemented here, deliberately, rather than imported: those
 * functions can move or be renamed without notice, and this package would
 * rather fail a test against real directory names than depend on an internal
 * path it does not own. `encodeSessionDirName` below is kept in exact sync by
 * testing it against every awkward flattened name actually observed on a real
 * `~/.omp/agent/sessions/` tree (see cwd-codec.test.ts).
 *
 * The encoding is inherently lossy. `encodeRelativeSessionDirName` replaces
 * every `/`, `\`, and `:` in a relative path with the same `-`, so:
 *
 *   - A two-level directory ("a/b") and a hyphenated single directory ("a-b")
 *     flatten identically.
 *   - A home-relative "tmp/x" and a temp-relative "x" (i.e. `os.tmpdir()/x`)
 *     both flatten to "-tmp-x" -- home scope prefixes with "-" and that
 *     already ends in "-", so "-" + "tmp-x" == "-tmp" + "-" + "x".
 *
 * Decoding therefore never guesses a split. It walks the REAL directory tree
 * from each candidate scope root and only accepts a real subdirectory name as
 * a match for a prefix of the remaining flattened string, exactly as the
 * encoder would have produced it. A flattened name decodes with confidence
 * only when exactly one real directory reconstructs it byte-for-byte (proven
 * by re-encoding the candidate and comparing) across every scope that could
 * have produced it. Zero or more than one real match is reported as unknown.
 * A wrong guess would silently merge two projects' sessions into one group;
 * refusing to decode does not.
 */

import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Matches upstream's `resolveEquivalentPath`: resolve symlinks, fall back to the merely-absolute path when the target does not exist. */
function resolveEquivalentPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function encodeRelativeSegment(prefix: string, relative: string): string {
  const encoded = relative.replace(/[/\\:]/g, "-");
  if (!encoded) return prefix;
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

/**
 * `path.relative("/", resolved)` reduces to exactly the same string as
 * upstream's `resolved.replace(/^[/\\]/, "")` for any absolute POSIX path,
 * so generalizing to an injectable root changes nothing at the real "/"
 * default and gives decode's abs-scope walk a fixture root to test against
 * instead of the literal, un-substitutable filesystem root.
 */
function encodeAbsoluteSegment(resolvedCwd: string, absRoot: string): string {
  const resolved = path.resolve(resolvedCwd);
  const relative = path.relative(absRoot, resolved).replace(/[/\\:]/g, "-");
  return `--${relative}--`;
}

/**
 * Forward encoder, matching upstream's `getDefaultSessionDirName` exactly:
 * home-relative first, then temp-relative, then the legacy absolute fallback.
 * Exported so decode's candidates can be proven by round-tripping through it,
 * and so tests can assert this package's encoder agrees with observed reality
 * without needing a second, hidden implementation to trust.
 */
export function encodeSessionDirName(
  cwd: string,
  homeDir: string = os.homedir(),
  tmpDir: string = os.tmpdir(),
  absRoot = "/",
): string {
  const resolvedCwd = path.resolve(cwd);
  const canonicalCwd = resolveEquivalentPath(resolvedCwd);
  const canonicalHome = resolveEquivalentPath(homeDir);
  const canonicalTemp = resolveEquivalentPath(tmpDir);
  const homeRelative = path.relative(canonicalHome, canonicalCwd);
  const tempRelative = path.relative(canonicalTemp, canonicalCwd);

  if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
    return encodeRelativeSegment("-", homeRelative);
  }
  if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
    return encodeRelativeSegment("-tmp", tempRelative);
  }
  return encodeAbsoluteSegment(canonicalCwd, resolveEquivalentPath(absRoot));
}

export type CwdScope = "home" | "tmp" | "abs";

export type DecodedCwd =
  | { status: "ok"; cwd: string; scope: CwdScope }
  | { status: "unknown"; reason: "no_match" }
  | { status: "unknown"; reason: "ambiguous"; candidates: string[] };

/** A directory tree walk this large is pathological input, not a real project tree; stop and report ambiguous rather than hang. */
const MAX_DECODE_NODES = 20_000;
const MAX_DECODE_DEPTH = 32;

/**
 * Real, traversable subdirectory names of `dir`: true directories, plus
 * symlinks that resolve to one. Symlinks matter here specifically because
 * macOS resolves `/tmp` -> `/private/tmp` and `/var` -> `/private/var`, and a
 * canonicalized cwd under either produces a flattened name built from the
 * `/private/...` form while the traversable path from "/" still passes
 * through the symlinked `var`/`tmp` entries -- `fs.readdirSync` follows them
 * transparently for the directories it descends into, but `Dirent.isDirectory()`
 * on the symlink entry itself is false, so filtering on that alone would
 * silently prune the exact path this decoder most needs to walk.
 */
function listTraversableDirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if (statSync(path.join(dir, entry.name)).isDirectory()) names.push(entry.name);
      } catch {
        // Broken symlink; not traversable.
      }
    }
  }
  return names;
}

/**
 * Every sequence of real subdirectories under `root` whose names, joined by
 * the same lossy dash rule the encoder applies, reconstruct `remainder`
 * exactly. Bounded by a node budget so a pathological flattened name cannot
 * hang the scan; exceeding it is reported by returning `null`, which the
 * caller treats identically to "found more than one match" -- never as "found
 * none", which would be a false confidence in the other direction.
 */
function walkRemainder(root: string, remainder: string): string[][] | null {
  if (remainder === "") return [[]];
  if (!existsSync(root)) return [];

  let budget = MAX_DECODE_NODES;
  const matches: string[][] = [];
  let exhausted = false;

  function recurse(dir: string, rem: string, segments: string[], depth: number): void {
    if (exhausted || depth > MAX_DECODE_DEPTH) return;
    for (const name of listTraversableDirs(dir)) {
      if (exhausted) return;
      if (budget-- <= 0) {
        exhausted = true;
        return;
      }
      if (rem === name) {
        matches.push([...segments, name]);
        continue;
      }
      if (rem.startsWith(`${name}-`)) {
        recurse(path.join(dir, name), rem.slice(name.length + 1), [...segments, name], depth + 1);
      }
    }
  }

  recurse(root, remainder, [], 0);
  return exhausted ? null : matches;
}

/**
 * Decode a flattened session directory name back to a real cwd.
 *
 * Tries every scope the name's shape is consistent with -- a name starting
 * with a single "-" is tried as both home-relative and (if it also starts
 * with "-tmp") temp-relative, because the encoding genuinely collides there
 * -- and only trusts the result when the candidates from every scope agree
 * on exactly one real directory, verified by re-encoding it and checking the
 * result equals `name`.
 */
export function decodeSessionDirName(
  name: string,
  homeDir: string = os.homedir(),
  tmpDir: string = os.tmpdir(),
  absRoot = "/",
): DecodedCwd {
  const candidates = new Map<string, CwdScope>();

  const record = (cwd: string, scope: CwdScope): void => {
    if (encodeSessionDirName(cwd, homeDir, tmpDir, absRoot) === name) {
      candidates.set(cwd, scope);
    }
  };

  let ambiguousInSubwalk = false;

  if (name === "-") {
    record(homeDir, "home");
  } else if (name === "-tmp") {
    record(tmpDir, "tmp");
  }

  if (name.length >= 4 && name.startsWith("--") && name.endsWith("--")) {
    const remainder = name.slice(2, -2);
    const matches = walkRemainder(absRoot, remainder);
    if (matches === null) {
      ambiguousInSubwalk = true;
    } else {
      for (const segments of matches) record(path.join(absRoot, ...segments), "abs");
    }
  }

  if (name.startsWith("-tmp-")) {
    const remainder = name.slice("-tmp-".length);
    const matches = walkRemainder(tmpDir, remainder);
    if (matches === null) {
      ambiguousInSubwalk = true;
    } else {
      for (const segments of matches) record(path.join(tmpDir, ...segments), "tmp");
    }
  }

  if (name.startsWith("-") && name !== "-" && !name.startsWith("--")) {
    const remainder = name.slice(1);
    const matches = walkRemainder(homeDir, remainder);
    if (matches === null) {
      ambiguousInSubwalk = true;
    } else {
      for (const segments of matches) record(path.join(homeDir, ...segments), "home");
    }
  }

  if (candidates.size === 1 && !ambiguousInSubwalk) {
    const entry = candidates.entries().next().value;
    if (entry) {
      const [cwd, scope] = entry;
      return { status: "ok", cwd, scope };
    }
  }
  if (candidates.size === 0 && !ambiguousInSubwalk) {
    return { status: "unknown", reason: "no_match" };
  }
  return { status: "unknown", reason: "ambiguous", candidates: [...candidates.keys()] };
}
