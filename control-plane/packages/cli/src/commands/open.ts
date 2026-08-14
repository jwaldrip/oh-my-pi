/**
 * Open the console without putting the token in a URL.
 *
 * The app accepts `?token=...` and strips it from history on read, which is
 * fine for a QR handoff to a phone but wrong for a shell: the URL lands in
 * shell history, in the terminal scrollback, and in whatever the shell syncs.
 * A long-lived credential should not be recoverable from any of those.
 *
 * So this puts the token on the clipboard and opens the bare origin. The
 * console's pairing screen takes a paste, and the credential never becomes
 * part of an address.
 */

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../client.ts";
import { requireToken, resolveBaseUrl } from "../client.ts";

/** Clipboard writers by platform, first one that exists wins. */
const CLIPBOARD_COMMANDS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  linux: [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ],
  win32: [["clip"]],
};

const OPEN_COMMANDS: Record<string, string[]> = {
  darwin: ["open"],
  linux: ["xdg-open"],
  win32: ["cmd", "/c", "start", ""],
};

export interface OpenOutcome {
  url: string;
  clipboard: boolean;
  launched: boolean;
}

export async function openCommand(ctx: CliContext): Promise<number> {
  const base = resolveBaseUrl(ctx);
  // Fail before doing anything visible if there is no credential to hand over.
  const token = requireToken(ctx);
  const platform = ctx.env.OMPD_PLATFORM ?? process.platform;

  const clipboard = await copyToClipboard(ctx, platform, token);
  const launched = await launch(ctx, platform, base);

  ctx.out(`console  ${base}`);
  if (clipboard) {
    ctx.out("token    copied to your clipboard, not printed and not in the URL");
  } else {
    ctx.out(`token    read it from ${ctx.home}/token (no clipboard tool found)`);
  }
  ctx.out("");
  if (launched) {
    ctx.out("  Opened in your browser. On the pairing screen, paste the token and connect.");
  } else {
    ctx.out(`  Open ${base} and paste the token on the pairing screen.`);
  }
  ctx.out("  The console stores it locally, so this is a one time paste per device.");
  return 0;
}

async function copyToClipboard(
  ctx: CliContext,
  platform: string,
  token: string,
): Promise<boolean> {
  const candidates = CLIPBOARD_COMMANDS[platform] ?? [];
  if (candidates.length === 0) return false;

  // The token must not appear in argv, where `ps` would expose it to every
  // local process, and `exec` takes no stdin. So it goes through a file that
  // only this user can read and is removed immediately after.
  const scratch = join(tmpdir(), `ompd-clip-${randomUUID()}`);
  writeFileSync(scratch, token, { mode: 0o600 });
  try {
    for (const command of candidates) {
      if (command[0] === undefined) continue;
      const result = await ctx
        .exec(["sh", "-c", `${shellJoin(command)} < ${shellJoin([scratch])}`])
        .catch(() => null);
      if (result !== null && result.code === 0) return true;
    }
    return false;
  } finally {
    rmSync(scratch, { force: true });
  }
}

async function launch(ctx: CliContext, platform: string, url: string): Promise<boolean> {
  const opener = OPEN_COMMANDS[platform];
  if (opener === undefined) return false;
  const result = await ctx.exec([...opener, url]).catch(() => null);
  return result !== null && result.code === 0;
}

function shellJoin(command: string[]): string {
  return command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}
