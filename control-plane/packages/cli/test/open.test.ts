/**
 * `ompd open` exists to keep a long-lived credential out of a URL.
 *
 * The console accepts `?token=...` and strips it from history on read, which is
 * acceptable for a QR handoff to a phone but wrong from a shell: the URL lands
 * in shell history and terminal scrollback, neither of which the app can strip.
 * These tests pin the properties that make the command worth having, so a
 * future refactor cannot quietly reintroduce the footgun.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import type { CliContext } from "../src/client.ts";

interface Harness {
  ctx: CliContext;
  out: string[];
  err: string[];
  execs: string[][];
  home: string;
}

function harness(opts: { token?: string; platform?: string; execFails?: boolean } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "ompd-open-"));
  if (opts.token !== undefined) writeFileSync(join(home, "token"), opts.token);
  writeFileSync(join(home, "endpoint"), "http://127.0.0.1:7777");

  const out: string[] = [];
  const err: string[] = [];
  const execs: string[][] = [];
  const ctx: CliContext = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { OMPD_HOME: home, OMPD_PLATFORM: opts.platform ?? "darwin" },
    cwd: home,
    home,
    fetch: async () => new Response("{}", { status: 200 }),
    exec: async (command) => {
      execs.push(command);
      return opts.execFails === true
        ? { code: 1, stdout: "", stderr: "not found" }
        : { code: 0, stdout: "", stderr: "" };
    },
  };
  return { ctx, out, err, execs, home };
}

describe("ompd open", () => {
  test("never puts the token in a URL or in argv", async () => {
    // The whole point of the command. A token in argv is readable by any local
    // process via ps, and a token in a URL outlives the session in history.
    const token = "tok_supersecret_value_123";
    const h = harness({ token });
    const code = await run(["open"], h.ctx);
    expect(code).toBe(0);

    const everyArg = h.execs.flat().join(" ");
    expect(everyArg).not.toContain(token);

    const opened = h.execs.find((c) => c[0] === "open");
    expect(opened?.[1]).toBe("http://127.0.0.1:7777");
    expect(opened?.[1]).not.toContain("token");
    expect(opened?.[1]).not.toContain("?");

    rmSync(h.home, { recursive: true, force: true });
  });

  test("never prints the token", async () => {
    const token = "tok_supersecret_value_123";
    const h = harness({ token });
    await run(["open"], h.ctx);
    expect([...h.out, ...h.err].join("\n")).not.toContain(token);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("copies to the clipboard and says so", async () => {
    const h = harness({ token: "tok_abc" });
    await run(["open"], h.ctx);
    const clip = h.execs.find((c) => c.join(" ").includes("pbcopy"));
    expect(clip).toBeDefined();
    expect(h.out.join("\n")).toContain("clipboard");
    rmSync(h.home, { recursive: true, force: true });
  });

  test("falls back to naming the token file when no clipboard tool works", async () => {
    // Silence here would leave the operator staring at a pairing screen with no
    // way to fill it in.
    const h = harness({ token: "tok_abc", execFails: true });
    const code = await run(["open"], h.ctx);
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("token");
    expect(h.out.join("\n")).toContain(h.home);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("guides rather than crashing when there is no token", async () => {
    const h = harness({});
    const code = await run(["open"], h.ctx);
    expect(code).not.toBe(0);
    expect(h.err.join("\n")).toContain("ompd pair");
    // Nothing should have been launched on a failed run.
    expect(h.execs.find((c) => c[0] === "open")).toBeUndefined();
    rmSync(h.home, { recursive: true, force: true });
  });

  test("picks the platform's clipboard tool", async () => {
    const h = harness({ token: "tok_abc", platform: "linux" });
    await run(["open"], h.ctx);
    const joined = h.execs.map((c) => c.join(" ")).join("\n");
    expect(joined).toContain("wl-copy");
    expect(h.execs.find((c) => c[0] === "xdg-open")).toBeDefined();
    rmSync(h.home, { recursive: true, force: true });
  });
});
