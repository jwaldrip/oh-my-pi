/**
 * Proves the codec against a real, awkward directory tree rather than a tidy
 * synthetic one: `-Downloads`, `--private-tmp--`, and a `-no-such-directory`
 * suffix are directory names actually observed under a real
 * `~/.omp/agent/sessions/` on this project's own development machine.
 *
 * Abs-scope cases pass `privateRoot` as the codec's optional fourth `absRoot`
 * argument. That argument exists solely so this suite can point "the
 * filesystem root, for absolute-path purposes" at a disposable fixture
 * directory instead of the real `/` -- the algorithm exercised is identical
 * to production, which always calls with the default `absRoot = "/"`, and
 * the substitution is what lets the assertions below read as the exact
 * flattened strings observed on a real machine (`--private-tmp--`) rather
 * than a name salted with a temp-dir's random suffix.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionDirName, encodeSessionDirName } from "../../src/sessions/cwd-codec.ts";

const scratch: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Fixture {
  home: string;
  tmp: string;
  /** Stands in for "/" so abs-scope names read as the real machine's exact strings. */
  privateRoot: string;
}

/** Builds a fake home/tmp/private-root tree shaped like the real machine's awkward names: /private/tmp resolved via a symlink, a deleted temp working directory, and a home-relative multi-segment project path with a dotted, dash-bearing real segment (github.com). */
function buildFixture(): Fixture {
  const base = tempRoot("cwd-codec-fixture-");
  const privateRoot = join(base, "private");
  const home = join(privateRoot, "home", "operator");
  const realTmp = join(privateRoot, "var", "folders", "4b", "bucket", "T");
  mkdirSync(home, { recursive: true });
  mkdirSync(realTmp, { recursive: true });
  mkdirSync(join(home, "Downloads"), { recursive: true });
  mkdirSync(join(home, "dev", "src", "github.com", "acme", "widgets"), { recursive: true });
  mkdirSync(join(realTmp, "ompd-routine-live-work-7xH3HI"), { recursive: true });
  mkdirSync(join(privateRoot, "tmp", "ompd-proof"), { recursive: true });

  // The macOS-shaped symlink layer: /tmp -> /private/tmp, /var -> /private/var,
  // paralleling the real machine where os.tmpdir()'s /var/folders/... differs
  // from a literal `cd /tmp` even though both eventually resolve under /private.
  symlinkSync(join(privateRoot, "tmp"), join(base, "tmp"));
  symlinkSync(join(privateRoot, "var"), join(base, "var"));

  return { home, tmp: realTmp, privateRoot };
}

describe("encodeSessionDirName", () => {
  test("home directory itself encodes to a bare dash", () => {
    const { home, tmp } = buildFixture();
    expect(encodeSessionDirName(home, home, tmp)).toBe("-");
  });

  test("home-relative single segment", () => {
    const { home, tmp } = buildFixture();
    expect(encodeSessionDirName(join(home, "Downloads"), home, tmp)).toBe("-Downloads");
  });

  test("home-relative multi segment, including a real dotted directory name", () => {
    const { home, tmp } = buildFixture();
    expect(
      encodeSessionDirName(join(home, "dev", "src", "github.com", "acme", "widgets"), home, tmp),
    ).toBe("-dev-src-github.com-acme-widgets");
  });

  test("temp root itself encodes to bare -tmp", () => {
    const { home, tmp } = buildFixture();
    expect(encodeSessionDirName(tmp, home, tmp)).toBe("-tmp");
  });

  test("temp-relative segment", () => {
    const { home, tmp } = buildFixture();
    expect(encodeSessionDirName(join(tmp, "ompd-routine-live-work-7xH3HI"), home, tmp)).toBe(
      "-tmp-ompd-routine-live-work-7xH3HI",
    );
  });

  test("neither home nor temp descendant falls back to the legacy absolute scheme", () => {
    const { home, tmp, privateRoot } = buildFixture();
    // /private/tmp is real but distinct from the per-process temp root, the
    // same way `cd /tmp` differs from `os.tmpdir()` on macOS.
    expect(encodeSessionDirName(join(privateRoot, "tmp"), home, tmp, privateRoot)).toBe(
      "--tmp--",
    );
    expect(encodeSessionDirName(join(privateRoot, "tmp", "ompd-proof"), home, tmp, privateRoot)).toBe(
      "--tmp-ompd-proof--",
    );
  });
});

describe("decodeSessionDirName round-trips against the real filesystem", () => {
  test("bare dash decodes to home", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-", home, tmp)).toEqual({ status: "ok", cwd: home, scope: "home" });
  });

  test("-Downloads decodes to the real Downloads directory", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-Downloads", home, tmp)).toEqual({
      status: "ok",
      cwd: join(home, "Downloads"),
      scope: "home",
    });
  });

  test("a deep home-relative path decodes exactly, disambiguating a real dotted segment (github.com) from a directory boundary", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-dev-src-github.com-acme-widgets", home, tmp)).toEqual({
      status: "ok",
      cwd: join(home, "dev", "src", "github.com", "acme", "widgets"),
      scope: "home",
    });
  });

  test("bare -tmp decodes to the temp root", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-tmp", home, tmp)).toEqual({ status: "ok", cwd: tmp, scope: "tmp" });
  });

  test("-tmp-<segment> decodes through the symlinked /var chain (the real awkward case)", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-tmp-ompd-routine-live-work-7xH3HI", home, tmp)).toEqual({
      status: "ok",
      cwd: join(tmp, "ompd-routine-live-work-7xH3HI"),
      scope: "tmp",
    });
  });

  test("--tmp-- decodes through the /private/tmp symlink target, distinct from os.tmpdir()", () => {
    const { home, tmp, privateRoot } = buildFixture();
    expect(decodeSessionDirName("--tmp--", home, tmp, privateRoot)).toEqual({
      status: "ok",
      cwd: join(privateRoot, "tmp"),
      scope: "abs",
    });
  });

  test("--tmp-ompd-proof-- decodes to the nested real directory", () => {
    const { home, tmp, privateRoot } = buildFixture();
    expect(decodeSessionDirName("--tmp-ompd-proof--", home, tmp, privateRoot)).toEqual({
      status: "ok",
      cwd: join(privateRoot, "tmp", "ompd-proof"),
      scope: "abs",
    });
  });

  test("a deleted directory refuses to decode instead of inventing a path", () => {
    const { home, tmp, privateRoot } = buildFixture();
    // The real `--var-folders-...-no-such-directory--` shape: the abs scheme
    // fires because the cwd no longer exists on disk, and the walk cannot
    // find a real "ompd-routine-live-work-5KTyK4-no-such-directory" under T.
    const flattened = "--var-folders-4b-bucket-T-ompd-routine-live-work-5KTyK4-no-such-directory--";
    const decoded = decodeSessionDirName(flattened, home, tmp, privateRoot);
    expect(decoded.status).toBe("unknown");
    if (decoded.status === "unknown") expect(decoded.reason).toBe("no_match");
  });

  test("home vs temp collision on a name starting with -tmp reports ambiguous when both are real", () => {
    // Upstream's own scheme genuinely collides here: home-relative "tmp/x"
    // and temp-relative "x" both flatten to "-tmp-x" (home's "-" prefix
    // already ends in "-", so "-" + "tmp-x" == "-tmp" + "-" + "x"). Build
    // both real directories and confirm the decoder refuses to pick one.
    const home = tempRoot("cwd-codec-collision-home-");
    const tmp = tempRoot("cwd-codec-collision-tmp-");
    mkdirSync(join(home, "tmp", "x"), { recursive: true });
    mkdirSync(join(tmp, "x"), { recursive: true });
    const decoded = decodeSessionDirName("-tmp-x", home, tmp);
    expect(decoded.status).toBe("unknown");
    if (decoded.status === "unknown" && decoded.reason === "ambiguous") {
      expect(decoded.candidates.sort()).toEqual([join(home, "tmp", "x"), join(tmp, "x")].sort());
    } else {
      throw new Error(`expected ambiguous, got ${JSON.stringify(decoded)}`);
    }
  });

  test("an unrecognizable name with no real directory anywhere is unknown, not a guess", () => {
    const { home, tmp } = buildFixture();
    expect(decodeSessionDirName("-this-path-does-not-exist-anywhere", home, tmp)).toEqual({
      status: "unknown",
      reason: "no_match",
    });
  });

  test("every encode output for every real directory in the fixture decodes back to that exact directory", () => {
    const { home, tmp, privateRoot } = buildFixture();
    const realDirs = [
      home,
      join(home, "Downloads"),
      join(home, "dev", "src", "github.com", "acme", "widgets"),
      tmp,
      join(tmp, "ompd-routine-live-work-7xH3HI"),
      join(privateRoot, "tmp"),
      join(privateRoot, "tmp", "ompd-proof"),
    ];
    for (const dir of realDirs) {
      const flattened = encodeSessionDirName(dir, home, tmp, privateRoot);
      const decoded = decodeSessionDirName(flattened, home, tmp, privateRoot);
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") expect(decoded.cwd).toBe(dir);
    }
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
