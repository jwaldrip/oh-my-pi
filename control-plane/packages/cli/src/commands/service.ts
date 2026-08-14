/**
 * `ompd install` and `ompd uninstall`: the launchd agent.
 *
 * Both are idempotent, and both refuse to touch a plist at this path that ompd
 * did not write. Installing a background service is one of the few things a
 * CLI does that outlives every process involved, so overwriting a file someone
 * else authored, at a path they chose, is not a recoverable mistake. The
 * marker is what tells the two cases apart.
 *
 * The same reasoning applies to what the plist points at, and that is the
 * harder half. launchd stores an absolute path and re-execs it at every login
 * for as long as the file is there. A path into a checkout is a promise the
 * checkout cannot keep: a linked git worktree is deleted the moment its branch
 * is done, and the login agent then fails at every login with nothing on
 * screen to say why. So `install` refuses a program inside a checkout, names
 * `ompd self-install` as the fix, and prints the path it settled on.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "../args.ts";
import type { CliContext } from "../client.ts";
import { defaultPrefix, resolveProgram, type ProgramResolution } from "../install.ts";

export const LAUNCHD_LABEL = "sh.ompd";

/**
 * Proof that ompd wrote a plist.
 *
 * It lives in `EnvironmentVariables` because that is a free-form dictionary
 * launchd is guaranteed to accept, unlike an invented top-level key. Detection
 * is a literal search for the key element rather than a plist parse: the
 * question is only "did we write this", and pulling in an XML parser to answer
 * it would be more machinery than the answer is worth.
 */
export const PLIST_MARKER = "OMPD_MANAGED_PLIST";

/**
 * The program the agent runs, recorded a second time as an environment key.
 *
 * It is already `ProgramArguments[0]`, but reading it back out of there means
 * parsing an array out of XML. `doctor` has to answer "does the path this
 * agent will exec still exist" every time it runs, and this makes that a
 * single lookup against a file we wrote ourselves.
 */
export const PLIST_PROGRAM_KEY = "OMPD_PROGRAM";

export function plistPath(ctx: CliContext): string {
  const home = ctx.env.HOME ?? homedir();
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The plist launchd will hold onto.
 *
 * Two fields have to outlive whatever directory this command was typed in.
 * `ProgramArguments` is the obvious one. `WorkingDirectory` is the quiet one:
 * launchd chdirs before it execs, so a cwd that has been deleted fails the job
 * before the program ever runs, and it fails it exactly the same silent way.
 * Home is used because it is the one directory certain to still be there.
 */
export function renderPlist(ctx: CliContext, program: ProgramResolution): string {
  const args = [...program.argv, "start", "--foreground"];
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${PLIST_MARKER}</key>
    <string>1</string>
    <key>${PLIST_PROGRAM_KEY}</key>
    <string>${escapeXml(program.program)}</string>
    <key>OMPD_HOME</key>
    <string>${escapeXml(ctx.home)}</string>
    <key>PATH</key>
    <string>${escapeXml(ctx.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ctx.env.HOME ?? homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(ctx.home, "ompd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(ctx.home, "ompd.log"))}</string>
</dict>
</plist>
`;
}

/** The program path a plist we wrote names, or null if it names none. */
export function plistProgram(contents: string): string | null {
  const match = new RegExp(
    `<key>${PLIST_PROGRAM_KEY}</key>\\s*<string>([^<]*)</string>`,
  ).exec(contents);
  return match?.[1] ?? null;
}

/** Null when nothing is there; otherwise whether ompd wrote it. */
function inspectPlist(path: string): { ours: boolean } | null {
  if (!existsSync(path)) return null;
  return { ours: readFileSync(path, "utf8").includes(`<key>${PLIST_MARKER}</key>`) };
}

function foreignPlistMessage(path: string): string[] {
  return [
    `${path} exists and ompd did not write it.`,
    `  It carries no ${PLIST_MARKER} marker, so overwriting it would clobber someone else's`,
    "  launch agent. Move or remove it yourself, then run this again.",
  ];
}

function sourcePathMessage(program: ProgramResolution): string[] {
  return [
    `refusing to install a launch agent that runs ${program.program}`,
    `  That path is inside the checkout at ${program.checkout ?? "unknown"}, and launchd will`,
    "  hold it across every login. A linked worktree is removed as soon as its branch is",
    "  done, and the agent then fails silently at each login for good.",
    "",
    "  Install a standalone binary first:",
    "    ompd self-install",
    "    ompd install",
    "",
    "  Or, if this really is a permanent checkout you maintain yourself:",
    "    ompd install --allow-source-path",
  ];
}

export async function installCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "install" }>,
): Promise<number> {
  const path = plistPath(ctx);
  const existing = inspectPlist(path);

  if (existing !== null && !existing.ours) {
    for (const line of foreignPlistMessage(path)) ctx.err(line);
    return 1;
  }

  const program = resolveProgram(cmd.prefix ?? defaultPrefix(ctx.env));
  if (program.checkout !== null && !cmd.allowSourcePath) {
    for (const line of sourcePathMessage(program)) ctx.err(line);
    return 1;
  }

  mkdirSync(dirname(path), { recursive: true });
  // Unload before rewriting: launchd holds the old definition, so a reinstall
  // that only rewrote the file would leave the previous arguments running.
  if (existing !== null) await ctx.exec(["launchctl", "unload", path]);

  writeFileSync(path, renderPlist(ctx, program));

  const loaded = await ctx.exec(["launchctl", "load", path]);
  if (loaded.code !== 0) {
    ctx.err(`wrote ${path} but launchctl load failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`);
    return 1;
  }

  ctx.out(existing === null ? `installed ${path}` : `reinstalled ${path}`);
  ctx.out(`  label   ${LAUNCHD_LABEL}`);
  // Printed, not implied. What launchd will exec at every login for the rest
  // of this machine's life should never be something you have to open a plist
  // to discover.
  ctx.out(`  runs    ${program.program}`);
  if (program.checkout !== null) {
    ctx.out(`          inside the checkout at ${program.checkout}; it breaks if that is removed`);
  }
  ctx.out(`  logs    ${join(ctx.home, "ompd.log")}`);
  ctx.out("  it starts at login and restarts on failure; `ompd status` to check");
  return 0;
}

export async function uninstallCommand(ctx: CliContext): Promise<number> {
  const path = plistPath(ctx);
  const existing = inspectPlist(path);

  if (existing === null) {
    ctx.out(`nothing to uninstall: ${path} does not exist`);
    return 0;
  }
  if (!existing.ours) {
    for (const line of foreignPlistMessage(path)) ctx.err(line);
    return 1;
  }

  // A plist that is present but never loaded makes unload fail, which is not
  // a failure of uninstalling.
  await ctx.exec(["launchctl", "unload", path]);
  rmSync(path);

  ctx.out(`uninstalled ${path}`);
  ctx.out("  the daemon's state under ~/.ompd is left alone");
  return 0;
}
