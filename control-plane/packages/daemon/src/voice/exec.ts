/**
 * The subprocess seam for the speech engines.
 *
 * Voice is a transport problem: every engine here is a thin wrapper over a
 * binary that already exists on the machine. Which means engine *selection* is
 * the interesting logic, and selection is decided entirely by what `which` and
 * a probe command answer. Routing both through an interface makes the fallback
 * order testable without a microphone, a model download, or the machine's
 * actual PATH deciding whether the test passes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Absolute path of `bin`, or null when it is not on PATH. */
  which(bin: string): string | null;
  run(bin: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
}

/**
 * Result of asking whether an engine can run here. The reason is not decoration:
 * it is what the terminal null engine reports when the operator asks why the
 * daemon cannot hear or speak.
 */
export interface EngineAvailability {
  available: boolean;
  reason: string;
}

/** Raised when a speech binary exceeds its deadline; the child is killed first. */
export class CommandTimeoutError extends Error {
  constructor(bin: string, timeoutMs: number) {
    super(`${bin} exceeded ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class BunCommandRunner implements CommandRunner {
  which(bin: string): string | null {
    return Bun.which(bin);
  }

  async run(
    bin: string,
    args: readonly string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

    const deadline = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => deadline.resolve("timeout"), timeoutMs);
    try {
      const outcome = await Promise.race([proc.exited, deadline.promise]);
      if (outcome === "timeout") {
        proc.kill("SIGKILL");
        throw new CommandTimeoutError(bin, timeoutMs);
      }
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: outcome, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Run `fn` against a private 0700 scratch directory and remove it afterwards.
 *
 * Audio handed to a speech binary is a transcript of whatever the operator
 * just said, so it does not belong in a predictable path another local user
 * could pre-create or read. Same reasoning as the ACP gate config.
 */
export async function withScratchDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
