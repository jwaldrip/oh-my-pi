#!/usr/bin/env bun
/**
 * Typecheck one control-plane project and gate on this layer's own diagnostics.
 *
 * The real dependency graph is checked, not a stand-in for it. `@ompd/daemon`
 * imports `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-utils` as source, so
 * every call into the fork is verified against the fork's actual types. That is
 * the whole point of running the compiler here rather than declaring the
 * upstream surface ourselves, which would compile happily after upstream
 * renamed something out from under it.
 *
 * What this does not do is fail on a diagnostic in a file this layer does not
 * own. The fork's own gate (`bun --cwd=packages/ai run check:types`, and the
 * same for `coding-agent` and `utils`) reports errors today on an untouched
 * checkout, and its base config is looser than this one -- no
 * `noUncheckedIndexedAccess` -- so its sources also collect diagnostics that
 * only exist because a stricter project pulled them in. Gating on those would
 * mean this layer could never be green for reasons no change here can fix.
 * They are still printed, counted, and attributed, so nothing is hidden.
 *
 * Failing closed is the other half. A compiler that crashes, cannot open its
 * project, or emits something this parser does not recognise is a failure, not
 * an empty diagnostic list: a check that answers "clean" when it never ran is
 * worse than no check at all.
 */

import { dirname, relative as relativeTo, resolve, sep } from "node:path";

/** `path(line,col): error TS1234: message`, which is every diagnostic tsgo prints. */
const DIAGNOSTIC = /^(?<path>[^(]+)\((?<line>\d+),(?<col>\d+)\): (?<severity>error|warning) (?<code>TS\d+): (?<message>.*)$/;

/** Lines a run can legitimately produce that are not diagnostics. */
const IGNORABLE = [
  /^\s*$/,
  // Continuation lines of a multi-line diagnostic, which tsgo indents.
  /^\s+/,
  /^Found \d+ error/,
  /^No errors/,
];

interface Diagnostic {
  path: string;
  line: number;
  code: string;
  message: string;
  ours: boolean;
}

const repoRoot = resolve(import.meta.dirname, "..", "..");
const ownedPrefix = `control-plane${sep}`;

/**
 * Where a diagnostic's file actually is, and whether this layer owns it.
 *
 * `tsgo` prints paths relative to its own working directory, and that
 * directory is not fixed: the root gate runs each package's `check` from that
 * package, so the same file arrives as `src/daemon.ts` there and as
 * `control-plane/packages/daemon/src/daemon.ts` from the repo root. Resolving
 * against anything but the directory the compiler actually ran in is how a
 * control-plane diagnostic gets filed as somebody else's and stops gating.
 */
function classify(path: string, spawnedIn: string): { path: string; ours: boolean } {
  const absolute = resolve(spawnedIn, path);
  const fromRoot = relativeTo(repoRoot, absolute);
  // A path outside the repo is not this layer's to gate on, and reporting it
  // absolute at least says so plainly.
  if (fromRoot.startsWith("..")) return { path: absolute, ours: false };
  return { path: fromRoot, ours: fromRoot.startsWith(ownedPrefix) };
}

function parse(output: string, spawnedIn: string): { diagnostics: Diagnostic[]; unparsed: string[] } {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  for (const raw of output.split("\n")) {
    const match = DIAGNOSTIC.exec(raw);
    if (match?.groups) {
      const located = classify(match.groups.path ?? "", spawnedIn);
      diagnostics.push({
        path: located.path,
        line: Number(match.groups.line),
        code: match.groups.code ?? "",
        message: match.groups.message ?? "",
        ours: located.ours,
      });
      continue;
    }
    if (raw.length > 0 && !IGNORABLE.some((pattern) => pattern.test(raw))) unparsed.push(raw);
  }
  return { diagnostics, unparsed };
}

function summarize(diagnostics: Diagnostic[]): string[] {
  const byArea = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    // `packages/ai`, `node_modules/onnxruntime-common`: two segments is enough
    // to name who owns the file without listing thousands of lines.
    const area = diagnostic.path.split(sep).slice(0, 2).join(sep);
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  return [...byArea].sort((a, b) => b[1] - a[1]).map(([area, count]) => `    ${count} ${area}`);
}

const projects = process.argv.slice(2);
if (projects.length === 0) {
  console.error("usage: check-types.ts <tsconfig.json> [...]");
  process.exit(2);
}

let failed = false;
for (const project of projects) {
  // Spawned in the project's own directory so the compiler's relative paths
  // have exactly one meaning, whichever directory this script was called from.
  const projectPath = resolve(process.cwd(), project);
  const spawnedIn = dirname(projectPath);
  const run = Bun.spawnSync(["bunx", "tsgo", "-p", projectPath, "--noEmit"], { cwd: spawnedIn });
  const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
  const { diagnostics, unparsed } = parse(output, spawnedIn);
  const ours = diagnostics.filter((diagnostic) => diagnostic.ours);
  const theirs = diagnostics.filter((diagnostic) => !diagnostic.ours);

  // A nonzero exit with no diagnostic at all is the compiler failing to run.
  // Trusting it would turn a broken invocation into a silent pass.
  if (run.exitCode !== 0 && diagnostics.length === 0) {
    console.error(`${project}: tsgo exited ${run.exitCode} without diagnostics`);
    console.error(output.trim() || "(no output)");
    failed = true;
    continue;
  }
  if (unparsed.length > 0) {
    console.error(`${project}: unrecognised compiler output, treating as failure`);
    for (const line of unparsed.slice(0, 10)) console.error(`  ${line}`);
    failed = true;
  }

  if (theirs.length > 0) {
    console.log(`${project}: ${theirs.length} diagnostics outside control-plane (not gating)`);
    for (const line of summarize(theirs)) console.log(line);
  }
  if (ours.length === 0) {
    console.log(`${project}: clean`);
    continue;
  }
  console.error(`${project}: ${ours.length} diagnostics in control-plane`);
  for (const diagnostic of ours) {
    console.error(`  ${diagnostic.path}:${diagnostic.line} ${diagnostic.code}: ${diagnostic.message}`);
  }
  failed = true;
}

process.exit(failed ? 1 : 0);
