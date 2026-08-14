/**
 * `<home>/config.json`, read and written directly rather than over the
 * daemon's socket.
 *
 * Every other command goes over HTTP because a running daemon is the only
 * writer of its own state. Config is different: nothing serves it, the
 * daemon reads it once at its own startup and never again, so there is no
 * route that could change it even if one existed. Editing the file directly
 * is not a shortcut around the daemon, it is the only way this value can be
 * touched between a stop and the next start, and `loadConfig` (the daemon's
 * own function, imported rather than re-implemented) is still the one place
 * its shape is enforced.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_CONFIG, ensureHome, loadConfig, type OmpdConfig } from "@ompd/daemon";
import { UsageError, type Command } from "../args.ts";
import type { CliContext } from "../client.ts";
import { table } from "../format.ts";

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as Array<keyof OmpdConfig>;

/** The file's own contents, nothing merged in. An absent file reads as empty. */
function readFileConfig(home: string): Record<string, unknown> {
  const path = join(home, "config.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Shared by `get` and `set`, so a typo is refused in the same words either way. */
function requireKnownKey(key: string): void {
  if (!CONFIG_KEYS.includes(key as keyof OmpdConfig)) {
    throw new UsageError(`unknown config key ${key}; known keys are ${CONFIG_KEYS.join(", ")}`);
  }
}

export async function configListCommand(ctx: CliContext): Promise<number> {
  const fromFile = readFileConfig(ctx.home);
  const effective = loadConfig(ctx.home);
  const rows = CONFIG_KEYS.map((key) => [
    key,
    String(effective[key]),
    key in fromFile ? "file" : "default",
  ]);
  for (const line of table(["KEY", "VALUE", "SOURCE"], rows)) ctx.out(line);
  return 0;
}

export async function configGetCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "config"; action: "get" }>,
): Promise<number> {
  requireKnownKey(cmd.key);
  const effective = loadConfig(ctx.home);
  ctx.out(String(effective[cmd.key as keyof OmpdConfig]));
  return 0;
}

export async function configSetCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "config"; action: "set" }>,
): Promise<number> {
  requireKnownKey(cmd.key);

  // `port` and `keepAwake` are the only two keys whose JSON type is not a
  // plain string, so a typed value has to be built before `loadConfig` (which
  // only ever sees what a config file could already contain) can judge it.
  let value: unknown = cmd.value;
  if (cmd.key === "port") {
    value = Number(cmd.value);
    if (!Number.isInteger(value)) throw new UsageError(`port must be an integer, got ${cmd.value}`);
  } else if (cmd.key === "keepAwake") {
    if (cmd.value !== "true" && cmd.value !== "false") {
      throw new UsageError(`keepAwake must be true or false, got ${cmd.value}`);
    }
    value = cmd.value === "true";
  }

  // The daemon's own loadConfig is the one place this shape is enforced, so a
  // bad hubUrl scheme or a policyMode typo is refused here in exactly the
  // words it would be refused at the daemon's own startup: this call raises
  // them, and nothing here catches or restates the error.
  loadConfig(ctx.home, { [cmd.key]: value } as Partial<OmpdConfig>);

  const fromFile = readFileConfig(ctx.home);
  fromFile[cmd.key] = value;
  ensureHome(ctx.home);
  writeConfigAtomically(ctx.home, fromFile);

  ctx.out(`set ${cmd.key} = ${JSON.stringify(value)}`);
  ctx.out("  a running daemon reads this file only at its own startup; restart it to pick");
  ctx.out("  up the change");
  return 0;
}

/**
 * Replace `<home>/config.json` in one step, or leave the old one intact.
 *
 * A truncate-then-write has a window in which the file on disk is empty or
 * half a JSON object, and the daemon reads this file at startup and refuses to
 * start on one that is not valid JSON. A machine that lost power, or an
 * interrupted write, would therefore take the daemon down and the operator
 * would be reading a parse error rather than a config. Writing a sibling and
 * renaming means the only two states a reader can observe are the old file and
 * the new one.
 *
 * The temp file is created in the same directory on purpose: rename is atomic
 * within a filesystem and merely a copy across one. Its name is random rather
 * than derived from the pid, because pids are recycled and an `wx` create
 * against a leftover from a dead process would refuse every future write until
 * someone deleted a file they never knew was there. Any failure before the
 * rename takes the sibling with it for the same reason.
 */
function writeConfigAtomically(home: string, content: Record<string, unknown>): void {
  const path = join(home, "config.json");
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    // 0600 at creation rather than after the fact, so the window in which a
    // config naming a bind address is world readable does not exist. `wx`
    // refuses to reuse a name, which with a random suffix means this process
    // is the only writer of this file.
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(content, null, 2)}\n`);
      // The rename is ordered after the bytes, not after the page cache
      // decides: without this the directory entry can land while the contents
      // have not, which is the same broken config this function exists to
      // prevent.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    // Unconditional rather than only on failure: after a successful rename
    // there is nothing at this path, and anything added below the rename later
    // cannot reintroduce a leftover by forgetting a branch.
    rmSync(temp, { force: true });
  }
}
