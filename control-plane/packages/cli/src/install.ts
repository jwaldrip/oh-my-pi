/**
 * Where `ompd` lives on disk.
 *
 * Two commands need the same answer and neither can guess it. `self-install`
 * has to know where to put a binary and whether that place is on `PATH`.
 * `install` has to name a program in a launch agent, and a launch agent is the
 * one artifact here that outlives every process involved: launchd will hold
 * that path across reboots long after whoever typed the command has forgotten
 * it. Naming a path inside a checkout there is not a small mistake. A linked
 * git worktree is deleted the moment its branch is done with, and the login
 * agent then fails at every login, silently, forever.
 *
 * So the checkout test is the load-bearing part of this file, and it walks up
 * looking for a `.git` entry of either kind. A linked worktree's `.git` is a
 * FILE holding a `gitdir:` pointer, not a directory, which is exactly the case
 * an `isDirectory` check would wave through.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/**
 * Proof that ompd produced a binary, and the exact counterpart of
 * `PLIST_MARKER`.
 *
 * `bun build --compile` embeds the bundled source, so this literal is present
 * in every binary ompd builds and absent from anything it did not. That is
 * what lets `self-install` tell "my own previous install" from "a file someone
 * else put at this path", without ever executing the unknown file to ask.
 */
export const BINARY_MARKER = "OMPD_MANAGED_BINARY";

/** The name the binary is installed under, and looked up on `PATH` by. */
export const BINARY_NAME = "ompd";

/** Scan window. The binary is tens of megabytes; it is never read whole. */
const SCAN_CHUNK = 1 << 20;

/**
 * True when `path` carries `BINARY_MARKER` anywhere in its bytes.
 *
 * Chunked rather than a whole-file read because the thing being scanned is a
 * ~60MB executable and the answer is one boolean. The tail of each chunk is
 * carried into the next so a marker straddling a boundary is still found.
 */
export function isOmpdBinary(path: string): boolean {
  const needle = Buffer.from(BINARY_MARKER, "utf8");
  const overlap = needle.length - 1;
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK + overlap);

  const fd = openSync(path, "r");
  try {
    let carried = 0;
    for (;;) {
      const read = readSync(fd, buffer, carried, SCAN_CHUNK, null);
      if (read === 0) return false;

      const filled = carried + read;
      if (buffer.subarray(0, filled).includes(needle)) return true;

      carried = Math.min(overlap, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * True when this process is a `bun build --compile` artifact.
 *
 * A compiled binary mounts its own bundle at `/$bunfs/root`, so
 * `import.meta.dir` answers this with no filesystem access at all. Running
 * from source it is a real directory inside the checkout.
 */
export function isCompiledRuntime(): boolean {
  return import.meta.dir.startsWith("/$bunfs/");
}

/** The CLI entry point, as a path on disk. Meaningless when compiled. */
export function sourceEntry(): string {
  return resolve(import.meta.dir, "main.ts");
}

/**
 * How to re-exec this CLI.
 *
 * Compiled, the binary is the whole command. From source it is bun plus an
 * entry file. `ompd start` backgrounds itself by re-execing, so getting this
 * wrong means a compiled `ompd start` outside the repo looks for a `.ts` file
 * that is not there.
 */
export function selfExec(): string[] {
  return isCompiledRuntime() ? [process.execPath] : [process.execPath, sourceEntry()];
}

/**
 * The checkout `from` lives inside, or null.
 *
 * Both kinds of `.git` count. A linked worktree keeps a `.git` file, and that
 * is the case that motivates the whole check: the worktree is removed when the
 * branch is done and every absolute path into it stops resolving.
 */
export function findCheckoutRoot(from: string): string | null {
  let dir = resolve(from);
  const { root } = parse(dir);

  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * `~/.local/bin`.
 *
 * Read through the context's `HOME` rather than `homedir()` so a test can
 * install into a temp tree, and so `OMPD_HOME`-style redirection of one
 * command does not leave another writing to the real home.
 */
export function defaultPrefix(env: Record<string, string | undefined>): string {
  return join(env.HOME ?? homedir(), ".local", "bin");
}

/** True for a regular file with an execute bit set. */
export function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Every `PATH` entry, in order, with the empties dropped. */
export function pathEntries(env: Record<string, string | undefined>): string[] {
  return (env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
}

/** The first executable named `name` on `PATH`, or null. */
export function findOnPath(env: Record<string, string | undefined>, name: string): string | null {
  for (const entry of pathEntries(env)) {
    const candidate = join(entry, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Where a program the launch agent could name came from. */
export type ProgramOrigin = "installed" | "running" | "source";

export interface ProgramResolution {
  /**
   * The path that must still resolve at every future login. For a compiled
   * binary that is the binary; from source it is the entry file, because that
   * is the part that disappears with the checkout.
   */
  program: string;
  /** The launch agent's `ProgramArguments` prefix, before `start`. */
  argv: string[];
  origin: ProgramOrigin;
  /** The checkout `program` lives inside, when it lives in one. */
  checkout: string | null;
}

/**
 * What the launch agent should run, in order of how long it will keep working.
 *
 * An installed binary first: it is outside any checkout by construction and it
 * embeds its own runtime. Then this process, when this process is itself a
 * compiled binary. The source entry is last and is only ever a candidate so
 * that `install` can refuse it by name rather than by silence.
 */
export function resolveProgram(prefix: string): ProgramResolution {
  const installed = join(prefix, BINARY_NAME);
  if (isExecutableFile(installed)) {
    return {
      program: installed,
      argv: [installed],
      origin: "installed",
      checkout: findCheckoutRoot(dirname(installed)),
    };
  }

  if (isCompiledRuntime()) {
    return {
      program: process.execPath,
      argv: [process.execPath],
      origin: "running",
      checkout: findCheckoutRoot(dirname(process.execPath)),
    };
  }

  const entry = sourceEntry();
  return {
    program: entry,
    argv: [process.execPath, entry],
    origin: "source",
    checkout: findCheckoutRoot(dirname(entry)),
  };
}

interface ShellAdvice {
  /** Path under `$HOME`. */
  rc: string;
  syntax: "posix" | "fish";
}

/**
 * Which file a shell reads for interactive `PATH` edits.
 *
 * Keyed by the basename of `$SHELL`. Anything unlisted falls back to
 * `.profile`, which is the one file every Bourne-family shell reads.
 */
const SHELL_ADVICE: Record<string, ShellAdvice> = {
  zsh: { rc: ".zshrc", syntax: "posix" },
  bash: { rc: ".bashrc", syntax: "posix" },
  fish: { rc: ".config/fish/config.fish", syntax: "fish" },
  ksh: { rc: ".kshrc", syntax: "posix" },
  sh: { rc: ".profile", syntax: "posix" },
};

const FALLBACK_ADVICE: ShellAdvice = { rc: ".profile", syntax: "posix" };

export interface PathAdvice {
  /** True when `prefix` is already on `PATH` and nothing needs editing. */
  onPath: boolean;
  /** Absolute path to the rc file to edit. Only meaningful when not on path. */
  rcPath: string;
  /** The exact line to add. Only meaningful when not on path. */
  line: string;
}

/**
 * Whether `prefix` is reachable, and if not, exactly what to add where.
 *
 * Generic advice is worse than none: it sends someone editing a shell profile
 * they did not need to touch. So the answer is computed against this shell and
 * this `PATH`, and the caller says "already on your PATH" when it is.
 */
export function pathAdvice(env: Record<string, string | undefined>, prefix: string): PathAdvice {
  const home = env.HOME ?? homedir();
  const shell = (env.SHELL ?? "").split("/").pop() ?? "";
  const advice = SHELL_ADVICE[shell] ?? FALLBACK_ADVICE;

  const line =
    advice.syntax === "fish"
      ? `fish_add_path ${prefix}`
      : `export PATH="${prefix}:$PATH"`;

  return {
    onPath: pathEntries(env).includes(prefix),
    rcPath: join(home, advice.rc),
    line,
  };
}
