/**
 * Evaluation in isolation.
 *
 * A proposal is a diff, and a diff is only ever applied to a throwaway `git
 * worktree` checked out from the current HEAD. The running tree is never
 * touched, so a proposal that corrupts the build corrupts a directory in
 * `/tmp` and nothing else.
 *
 * Two details carry the weight:
 *
 * - `git apply --check` runs before `git apply`, so a patch that would apply
 *   only partially is refused outright. A half-applied tree that then fails its
 *   tests would report a verdict about a state no one proposed.
 * - The worktree is removed in a `finally`. A timeout, a throw, or a failed
 *   patch all converge on the same cleanup, because a leaked worktree is a
 *   stale registration in the real repository.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorktreeEvaluationInput {
  /** The real repository. Read from, never written to. */
  repoRoot: string;
  /** Unified diff to apply inside the isolated checkout. */
  diff: string;
  /** Verification command in argv form, run with the worktree as cwd. */
  command: string[];
  /** Commit-ish to check out. Defaults to the current HEAD. */
  baseRef?: string;
  timeoutMs?: number;
}

export interface WorktreeEvaluation {
  passed: boolean;
  log: string;
}

interface CommandResult {
  code: number;
  timedOut: boolean;
  output: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function evaluateInWorktree(
  input: WorktreeEvaluationInput,
): Promise<WorktreeEvaluation> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseRef = input.baseRef ?? "HEAD";

  if (input.command.length === 0) {
    return { passed: false, log: "no verification command configured" };
  }

  // Outside the repository on purpose: a scratch checkout inside the running
  // tree is one `git add -A` away from being committed by something else.
  const scratch = await mkdtemp(join(tmpdir(), "ompd-eval-"));
  const worktreePath = join(scratch, "tree");
  const patchPath = join(scratch, "proposal.patch");
  const log: string[] = [];
  let added = false;

  try {
    await writeFile(patchPath, input.diff.endsWith("\n") ? input.diff : `${input.diff}\n`, "utf8");

    const add = await run(
      ["git", "-C", input.repoRoot, "worktree", "add", "--detach", worktreePath, baseRef],
      input.repoRoot,
      timeoutMs,
    );
    if (add.code !== 0) {
      return { passed: false, log: `worktree add failed:\n${add.output}` };
    }
    added = true;

    const check = await run(
      ["git", "-C", worktreePath, "apply", "--check", "--whitespace=nowarn", patchPath],
      worktreePath,
      timeoutMs,
    );
    if (check.code !== 0) {
      return { passed: false, log: `patch does not apply cleanly:\n${check.output}` };
    }

    const apply = await run(
      ["git", "-C", worktreePath, "apply", "--whitespace=nowarn", patchPath],
      worktreePath,
      timeoutMs,
    );
    if (apply.code !== 0) {
      return { passed: false, log: `patch application failed after --check passed:\n${apply.output}` };
    }
    log.push("patch applied cleanly in isolated worktree");

    const verify = await run(input.command, worktreePath, timeoutMs);
    log.push(`$ ${input.command.join(" ")}`, verify.output.trimEnd());
    if (verify.timedOut) {
      log.push(`verification timed out after ${timeoutMs}ms`);
      return { passed: false, log: log.join("\n") };
    }
    log.push(`exit code ${verify.code}`);
    return { passed: verify.code === 0, log: log.join("\n") };
  } catch (err) {
    return {
      passed: false,
      log: `${log.join("\n")}\nevaluation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (added) {
      await run(
        ["git", "-C", input.repoRoot, "worktree", "remove", "--force", worktreePath],
        input.repoRoot,
        60_000,
      );
      await run(["git", "-C", input.repoRoot, "worktree", "prune"], input.repoRoot, 60_000);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function run(argv: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // A proposal must not inherit the operator's git identity prompts or a
    // pager that would never return.
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });

  const timer = Promise.withResolvers<"timeout">();
  const handle = setTimeout(() => timer.resolve("timeout"), timeoutMs);
  const finished = proc.exited.then(() => "exited" as const);

  const outcome = await Promise.race([finished, timer.promise]);
  clearTimeout(handle);

  if (outcome === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
    const partial = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: -1, timedOut: true, output: partial.join("") };
  }

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: proc.exitCode ?? -1, timedOut: false, output: `${out}${err}` };
}
