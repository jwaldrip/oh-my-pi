/**
 * The CLI, tested at the two seams that matter.
 *
 * Parsing is asserted directly, because argv is a user interface: every verb,
 * every flag spelling, and every rejection is a promise to someone typing at
 * three in the morning, and none of it needs a daemon to check.
 *
 * Behaviour is asserted through `run` with the whole outside world injected: a
 * fake fetch, a temp home, a recorded `launchctl`. Three properties get the
 * most attention.
 *
 * A missing token must produce an instruction. It is the single most likely
 * first-run state, and a stack trace there tells someone who only needs to
 * pair that the tool is broken.
 *
 * `install` must refuse a plist it did not write. Overwriting someone else's
 * launch agent is not a recoverable mistake, and the marker is the only thing
 * standing between the two cases.
 *
 * `approve` must print its token exactly once. The daemon keeps only a hash,
 * so a second copy does not exist anywhere; printing it twice, or not at all,
 * are both bugs an operator only discovers later.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCommand, USAGE, UsageError } from "../src/args.ts";
import { resolveBaseUrl, TOKEN_GUIDANCE, type CliContext } from "../src/client.ts";
import {
  PLIST_MARKER,
  PLIST_PROGRAM_KEY,
  plistPath,
  plistProgram,
} from "../src/commands/service.ts";
import { startupLines } from "../src/commands/daemon.ts";
import { BINARY_MARKER, findCheckoutRoot } from "../src/install.ts";
import { BUNDLE_PREFIX, parsePairingBundle } from "@ompd/core/pairing";
import { homeIdFor, OMPD_VERSION, type Ompd } from "@ompd/daemon";
import { run } from "../src/main.ts";

/** `ProgramArguments`, as the strings launchd would exec. */
function programArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  return [...(array?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? "");
}

const scratch: string[] = [];

interface Harness {
  ctx: CliContext;
  home: string;
  /** Every request `run` made, in order. */
  calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }>;
  /** Every command handed to `exec`, in order. */
  commands: string[][];
  stdout: () => string;
  stderr: () => string;
  /**
   * Add or replace canned routes after construction.
   *
   * Needed because a health body now carries the home's identity, and the home
   * is a temp directory this function creates, so the value cannot be known
   * until after the harness exists.
   */
  setRoutes: (extra: Record<string, { status?: number; body: unknown }>) => void;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HarnessOptions {
  /** Path and method to canned response. Anything unlisted 404s. */
  routes?: Record<string, { status?: number; body: unknown }>;
  token?: string | null;
  env?: Record<string, string | undefined>;
  execCode?: number;
  /**
   * Answer one external command specially, and let the rest fall through.
   * `self-install` shells out to a compiler and then to the thing it just
   * built, so a recorder alone cannot drive it.
   */
  onExec?: (command: string[]) => ExecResult | undefined;
}

function harness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "ompd-cli-"));
  scratch.push(home);
  if (opts.token !== null) writeFileSync(join(home, "token"), `${opts.token ?? "tok_local"}\n`);

  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const commands: string[][] = [];
  const routes: Record<string, { status?: number; body: unknown }> = { ...opts.routes };

  const ctx: CliContext = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { OMPD_URL: "http://127.0.0.1:19999", HOME: home, ...opts.env },
    cwd: home,
    home,
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname + new URL(url).search;
      const headers = new Headers(init?.headers);
      calls.push({
        url: path,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: headers.get("authorization"),
      });

      const route = routes[`${method} ${path}`] ?? routes[path];
      if (route === undefined) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    exec: async (command) => {
      commands.push(command);
      return opts.onExec?.(command) ?? { code: opts.execCode ?? 0, stdout: "", stderr: "" };
    },
  };

  return {
    ctx,
    home,
    calls,
    commands,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    setRoutes: (extra) => Object.assign(routes, extra),
  };
}

describe("startup output", () => {
  test("a backgrounded start replays what the child said, minus its banner", () => {
    const h = harness();
    const logPath = join(h.home, "ompd.log");
    // Non-ASCII on purpose. The offset the caller passes is `statSync().size`,
    // which counts bytes, so a reader that slices a decoded string would start
    // mid-line here and swallow the first thing the daemon actually said.
    const older = "an older run in /Users/joão/.ompd\n";
    writeFileSync(logPath, older);
    const from = statSync(logPath).size;
    expect(from).toBeGreaterThan(older.length);

    writeFileSync(
      logPath,
      older +
        "tts engine: omp (omp say (kokoro))\n" +
        "minted the local operator device and wrote its token to /x/token (mode 0600)\n" +
        "\n" +
        "ompd is listening at http://127.0.0.1:1234\n" +
        "  web UI       http://127.0.0.1:1234/\n",
    );

    // The mint message is the acceptance criterion: a first start has to say
    // it happened, and on the backgrounded path the daemon says it into a log
    // this process is the only one reading.
    expect(startupLines(logPath, from)).toEqual([
      "tts engine: omp (omp say (kokoro))",
      "minted the local operator device and wrote its token to /x/token (mode 0600)",
    ]);

    // Nothing from before the spawn, and nothing from the banner this process
    // prints itself.
    expect(startupLines(logPath, from).join("\n")).not.toContain("an older run");
    expect(startupLines(logPath, from).join("\n")).not.toContain("web UI");
  });

  test("a child that said nothing yields nothing", () => {
    const h = harness();
    const logPath = join(h.home, "ompd.log");
    writeFileSync(logPath, "ompd is listening at http://127.0.0.1:1234\n");
    expect(startupLines(logPath, 0)).toEqual([]);
    expect(startupLines(join(h.home, "absent.log"), 0)).toEqual([]);
  });
});

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("finding the daemon", () => {
  test("the published endpoint is used when OMPD_URL is not set", async () => {
    const h = harness({
      env: { OMPD_URL: undefined },
      routes: { "GET /v1/agents": { body: { agents: [] } } },
    });
    writeFileSync(join(h.home, "endpoint"), "http://127.0.0.1:49978\n");

    // A daemon started with `--port 0` listens somewhere the config file has
    // never heard of, and the next command still has to find it.
    expect(resolveBaseUrl(h.ctx)).toBe("http://127.0.0.1:49978");
    await run(["agents"], h.ctx);
    expect(h.calls).toHaveLength(1);
  });

  test("OMPD_URL outranks the published endpoint", () => {
    const h = harness({ env: { OMPD_URL: "http://elsewhere:1234/" } });
    writeFileSync(join(h.home, "endpoint"), "http://127.0.0.1:49978\n");
    // Trailing slash trimmed, so paths do not double up.
    expect(resolveBaseUrl(h.ctx)).toBe("http://elsewhere:1234");
  });

  test("config is the answer when nothing is published", () => {
    const h = harness({ env: { OMPD_URL: undefined } });
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ port: 8123 }));
    expect(resolveBaseUrl(h.ctx)).toBe("http://127.0.0.1:8123");
  });
});

describe("start", () => {
  test("a second start finds the published daemon and does not launch another", async () => {
    const h = harness({ env: { OMPD_URL: undefined } });
    h.setRoutes({
      "GET /v1/health": { body: { ok: true, version: "0.1.0", homeId: homeIdFor(h.home) } },
    });
    const endpoint = join(h.home, "endpoint");
    writeFileSync(endpoint, "http://127.0.0.1:54366\n");

    // `--port 0` is the case that has no predictable address, so the published
    // endpoint is the only thing that can answer "is one already running".
    expect(await run(["start", "--port", "0"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("already listening at http://127.0.0.1:54366");
    // Still there. Deleting it would strand the live daemon, which every
    // other command finds through this file.
    expect(readFileSync(endpoint, "utf8").trim()).toBe("http://127.0.0.1:54366");
  });

  test("a start on the configured port finds a daemon that published nothing", async () => {
    const h = harness({ env: { OMPD_URL: undefined } });
    h.setRoutes({
      "GET /v1/health": { body: { ok: true, version: "0.1.0", homeId: homeIdFor(h.home) } },
    });
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ port: 7777 }));

    expect(await run(["start"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("already listening at http://127.0.0.1:7777");
  });

  test("a foreign daemon on the port is refused, not adopted", async () => {
    // The defect this guards: any healthy listener used to count as ours, so a
    // second daemon on the port made `start` print success and exit 0 while
    // every later command talked to a daemon holding a different token.
    const h = harness({ env: { OMPD_URL: undefined } });
    h.setRoutes({
      "GET /v1/health": { body: { ok: true, version: "0.1.0", homeId: "someoneelse00000" } },
    });
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ port: 7777 }));

    expect(await run(["start"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("taken by a different ompd");
    expect(h.stdout()).not.toContain("already listening");
  });

  test("a listener that cannot identify itself is treated as foreign", async () => {
    // An older daemon, or something else entirely. Refusing to start beside an
    // unidentifiable listener is recoverable; adopting one silently is not.
    const h = harness({ env: { OMPD_URL: undefined } });
    h.setRoutes({ "GET /v1/health": { body: { ok: true, version: "0.1.0" } } });
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ port: 7777 }));

    expect(await run(["start"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("taken by a different ompd");
  });

  test("the foreground daemon arms its signal handlers before startup finishes", async () => {
    const h = harness();
    const events: string[] = [];
    // Never resolved: the interesting window is the one where startup is
    // still in flight.
    const startup = Promise.withResolvers<never>();

    // A structural stand-in for the daemon. `Ompd` has private fields, so it
    // cannot be implemented structurally; this is the DI seam, not a claim
    // about the real class.
    const stub = {
      tokenPath: join(h.home, "token"),
      installSignalHandlers: () => void events.push("handlers"),
      start: () => {
        events.push("start");
        return startup.promise;
      },
      stop: () => Promise.resolve(),
    } as unknown as Ompd;
    h.ctx.createDaemon = () => stub;

    void run(["start", "--foreground"], h.ctx);
    await Promise.resolve();

    // Startup probes speech engines, binds a port, and writes a token file. A
    // Ctrl-C in that window must reach `stop`, not the default handler.
    expect(events).toEqual(["handlers", "start"]);
  });
});

describe("argv parsing", () => {
  test("no arguments is help, not an error", () => {
    expect(parseCommand([])).toEqual({ kind: "help" });
    expect(parseCommand(["help"])).toEqual({ kind: "help" });
    expect(parseCommand(["status", "--help"])).toEqual({ kind: "help" });
  });

  test("start takes host, port, and foreground in any spelling", () => {
    expect(parseCommand(["start"])).toEqual({
      kind: "start",
      host: undefined,
      port: undefined,
      foreground: false,
    });
    expect(parseCommand(["start", "--port", "8080", "--host", "0.0.0.0", "--foreground"])).toEqual({
      kind: "start",
      host: "0.0.0.0",
      port: 8080,
      foreground: true,
    });
    // `--flag=value` and `--flag value` are the same thing.
    expect(parseCommand(["start", "--port=8080"]).kind).toBe("start");
    expect(parseCommand(["start", "--port=8080"])).toMatchObject({ port: 8080 });
  });

  test("start rejects a port that is not a port", () => {
    expect(() => parseCommand(["start", "--port", "http"])).toThrow(UsageError);
    expect(() => parseCommand(["start", "--port", "70000"])).toThrow(/between 0 and 65535/);
    // A flag swallowing the next flag as its value is the classic parser bug.
    expect(() => parseCommand(["start", "--port", "--foreground"])).toThrow(/--port needs a value/);
  });

  test("status, agents, devices, routines take nothing", () => {
    expect(parseCommand(["status"])).toEqual({ kind: "status" });
    expect(parseCommand(["agents"])).toEqual({ kind: "agents" });
    expect(parseCommand(["devices"])).toEqual({ kind: "devices" });
    expect(parseCommand(["routines"])).toEqual({ kind: "routines" });
    expect(() => parseCommand(["status", "extra"])).toThrow(/status takes 0 arguments/);
  });

  test("pair defaults to the least useful scopes and validates the rest", () => {
    expect(parseCommand(["pair", "phone"])).toEqual({
      kind: "pair",
      name: "phone",
      scopes: ["read", "prompt"],
    });
    expect(parseCommand(["pair", "phone", "--scopes", "read,manage"])).toMatchObject({
      scopes: ["read", "manage"],
    });
    // Duplicates collapse; whitespace is tolerated.
    expect(parseCommand(["pair", "phone", "--scopes", "read, read , prompt"])).toMatchObject({
      scopes: ["read", "prompt"],
    });
    expect(() => parseCommand(["pair"])).toThrow(/missing <name>/);
    expect(() => parseCommand(["pair", "phone", "--scopes", "admin"])).toThrow(/unknown scope admin/);
  });

  test("approve requires explicit scopes", () => {
    expect(parseCommand(["approve", "123456", "--scopes", "read,prompt,manage,approve"])).toEqual({
      kind: "approve",
      code: "123456",
      scopes: ["read", "prompt", "manage", "approve"],
    });
    // The line that grants authority does not get a default grant.
    expect(() => parseCommand(["approve", "123456"])).toThrow(/approve needs --scopes/);
    expect(() => parseCommand(["approve"])).toThrow(/missing <code>/);
  });

  test("invite defaults to the same scopes as pair, unlike approve", () => {
    expect(parseCommand(["invite", "phone"])).toEqual({
      kind: "invite",
      name: "phone",
      scopes: ["read", "prompt"],
    });
    expect(parseCommand(["invite", "phone", "--scopes", "read,manage"])).toMatchObject({
      scopes: ["read", "manage"],
    });
    expect(() => parseCommand(["invite"])).toThrow(/missing <name>/);
  });

  test("agent and routine verbs take their one argument", () => {
    expect(parseCommand(["new", "/tmp/repo"])).toEqual({
      kind: "new",
      cwd: "/tmp/repo",
      name: undefined,
      container: false,
      image: undefined,
      mounts: undefined,
    });
    expect(parseCommand(["new", "/tmp/repo", "--name", "build"])).toMatchObject({ name: "build" });
    expect(parseCommand(["stop-agent", "agt_1"])).toEqual({ kind: "stop-agent", agentId: "agt_1" });
    expect(parseCommand(["run", "rt_1"])).toEqual({ kind: "run", routineId: "rt_1" });
    expect(parseCommand(["revoke", "dev_1"])).toEqual({ kind: "revoke", deviceId: "dev_1" });
    expect(() => parseCommand(["new"])).toThrow(/missing <cwd>/);
    expect(() => parseCommand(["stop-agent"])).toThrow(/missing <id>/);
    // Unquoted prompt text arrives as several positionals and must survive as
    // one string, or every prompt with a space in it is a usage error.
    expect(parseCommand(["prompt", "agt_1", "ship", "it"])).toEqual({
      kind: "prompt",
      agentId: "agt_1",
      text: "ship it",
    });
    expect(parseCommand(["prompt", "agt_1", "ship it"])).toMatchObject({ text: "ship it" });
    expect(() => parseCommand(["prompt", "agt_1"])).toThrow(/needs text/);
    expect(() => parseCommand(["prompt"])).toThrow(/missing <agentId>/);
  });

  test("new --container opts into a container host, --image and --mounts along with it", () => {
    expect(parseCommand(["new", "/tmp/repo", "--container"])).toEqual({
      kind: "new",
      cwd: "/tmp/repo",
      name: undefined,
      container: true,
      image: undefined,
      mounts: undefined,
    });
    expect(
      parseCommand([
        "new",
        "/tmp/repo",
        "--container",
        "--image",
        "ghcr.io/example/omp:1",
        "--mounts",
        "/data,/tools:rw",
      ]),
    ).toEqual({
      kind: "new",
      cwd: "/tmp/repo",
      name: undefined,
      container: true,
      image: "ghcr.io/example/omp:1",
      mounts: [{ hostPath: "/data" }, { hostPath: "/tools", mode: "rw" }],
    });
  });

  test("--image and --mounts require --container: naming a mount on a local agent is a usage error, not a silent no-op", () => {
    expect(() => parseCommand(["new", "/tmp/repo", "--image", "x"])).toThrow(/--image needs --container/);
    expect(() => parseCommand(["new", "/tmp/repo", "--mounts", "/data"])).toThrow(
      /--mounts needs --container/,
    );
  });

  test("parseMounts rejects an unknown mode instead of guessing", () => {
    expect(() => parseCommand(["new", "/tmp/repo", "--container", "--mounts", "/data:rx"])).toThrow(
      /unknown mode/,
    );
    expect(() => parseCommand(["new", "/tmp/repo", "--container", "--mounts", ""])).toThrow(
      /--mounts was empty/,
    );
  });

  test("rotate defaults to the caller's own credential", () => {
    // Bare `rotate` must mean "mine". A positional device id would make a
    // typo rotate a device that was working fine.
    expect(parseCommand(["rotate"])).toEqual({ kind: "rotate" });
    expect(parseCommand(["rotate", "--device", "dev_1"])).toEqual({
      kind: "rotate",
      deviceId: "dev_1",
    });
    expect(() => parseCommand(["rotate", "dev_1"])).toThrow(/rotate/);
  });

  test("audit has a limit with a default and a floor", () => {
    expect(parseCommand(["audit"])).toEqual({ kind: "audit", limit: 50 });
    expect(parseCommand(["audit", "--limit", "5"])).toEqual({ kind: "audit", limit: 5 });
    expect(() => parseCommand(["audit", "--limit", "0"])).toThrow(/must be positive/);
  });

  test("install and uninstall take nothing, and install gates the source path", () => {
    expect(parseCommand(["install"])).toEqual({ kind: "install", allowSourcePath: false });
    expect(parseCommand(["install", "--allow-source-path"])).toEqual({
      kind: "install",
      allowSourcePath: true,
    });
    expect(parseCommand(["install", "--prefix", "/opt/bin"])).toEqual({
      kind: "install",
      prefix: "/opt/bin",
      allowSourcePath: false,
    });
    expect(parseCommand(["uninstall"])).toEqual({ kind: "uninstall" });
  });

  test("self-install takes an optional prefix", () => {
    expect(parseCommand(["self-install"])).toEqual({ kind: "self-install" });
    expect(parseCommand(["self-install", "--prefix", "/opt/bin"])).toEqual({
      kind: "self-install",
      prefix: "/opt/bin",
    });
    expect(parseCommand(["doctor"])).toEqual({ kind: "doctor" });
  });

  test("--version is a version, not a bare invocation", async () => {
    // Both `--version` and no arguments at all arrive with no verb, so the
    // order of those two checks decides what `ompd --version` prints. Every
    // installer and `ompd doctor` read this to learn the version.
    expect(parseCommand(["--version"])).toEqual({ kind: "version" });
    expect(parseCommand([])).toEqual({ kind: "help" });

    const h = harness();
    expect(await run(["--version"], h.ctx)).toBe(0);
    expect(h.stdout()).toBe(OMPD_VERSION);
  });

  test("an unknown verb names itself", () => {
    expect(() => parseCommand(["frobnicate"])).toThrow(/unknown command frobnicate/);
  });

  test("config parses the bare form, get, and set", () => {
    expect(parseCommand(["config"])).toEqual({ kind: "config", action: "list" });
    expect(parseCommand(["config", "get", "hubUrl"])).toEqual({
      kind: "config",
      action: "get",
      key: "hubUrl",
    });
    expect(parseCommand(["config", "set", "hubUrl", "wss://hub.example.com"])).toEqual({
      kind: "config",
      action: "set",
      key: "hubUrl",
      value: "wss://hub.example.com",
    });
    expect(() => parseCommand(["config", "get"])).toThrow(/missing <key>/);
    expect(() => parseCommand(["config", "set", "hubUrl"])).toThrow(/missing <value>/);
    expect(() => parseCommand(["config", "get", "hubUrl", "extra"])).toThrow(/config get takes 1 argument/);
    expect(() => parseCommand(["config", "frobnicate"])).toThrow(/unknown config action frobnicate/);
  });
});

describe("missing token", () => {
  test("a command needing auth explains how to get one and makes no request", async () => {
    const h = harness({ token: null });
    const code = await run(["agents"], h.ctx);

    expect(code).toBe(1);
    expect(h.stderr()).toContain("No device token found");
    expect(h.stderr()).toContain("ompd start");
    expect(h.stderr()).toContain("ompd pair");
    // Not a crash, and not a request sent with no credential either.
    expect(h.stderr()).not.toContain("at <anonymous>");
    expect(h.calls).toHaveLength(0);
  });

  test("an empty token file counts as missing", async () => {
    const h = harness({ token: "   " });
    expect(await run(["devices"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain(TOKEN_GUIDANCE.split("\n")[0] as string);
  });

  test("OMPD_TOKEN is used when no file exists", async () => {
    const h = harness({ token: null, env: { OMPD_TOKEN: "tok_env" } });
    await run(["agents"], h.ctx);
    expect(h.calls[0]?.authorization).toBe("Bearer tok_env");
  });

  test("a token the daemon rejects blames revocation, not the restart", async () => {
    // Tokens survive restarts now. Telling an operator to expect otherwise
    // sends them to re-pair when what they actually need is to find out who
    // revoked the device.
    const h = harness({ routes: { "GET /v1/agents": { status: 401, body: { error: "unauthorized" } } } });
    expect(await run(["agents"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("revoked, rotated, or belongs to another daemon");
    expect(h.stderr()).not.toContain("do not survive a restart");
    // A token was found and presented. Claiming none was found sends the
    // operator to mint one when the device is the thing that needs attention.
    expect(h.stderr()).not.toContain("No device token found");
  });

  test("an unreachable daemon is advice, not a stack trace", async () => {
    const h = harness();
    h.ctx.fetch = () => Promise.reject(new Error("connect ECONNREFUSED"));

    expect(await run(["agents"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("no daemon is listening");
    expect(h.stderr()).toContain("ompd start");
  });

  test("a usage error prints usage and exits 2", async () => {
    const h = harness();
    expect(await run(["approve", "123456"], h.ctx)).toBe(2);
    expect(h.stderr()).toContain("approve needs --scopes");
    expect(h.stderr()).toContain(USAGE.split("\n")[0] as string);
  });
});

describe("approve", () => {
  test("prints the token exactly once and says it will not be shown again", async () => {
    const h = harness({
      routes: { "POST /v1/pairings/approve": { body: { token: "tok_minted_once" } } },
    });

    const code = await run(["approve", "123456", "--scopes", "read,prompt"], h.ctx);
    expect(code).toBe(0);

    const printed = h.stdout();
    // Exactly once. The daemon keeps only a hash, so a second copy of this
    // string does not exist anywhere.
    expect(printed.split("tok_minted_once")).toHaveLength(2);
    expect(printed).toContain("shown once");
    expect(printed).toContain("not recoverable");
    // Never on stderr as well, which would double it in a terminal.
    expect(h.stderr()).not.toContain("tok_minted_once");

    expect(h.calls[0]).toMatchObject({
      url: "/v1/pairings/approve",
      method: "POST",
      body: { code: "123456", scopes: ["read", "prompt"] },
      authorization: "Bearer tok_local",
    });
  });

  test("an escalation refusal surfaces as the daemon's reason", async () => {
    const h = harness({
      routes: {
        "POST /v1/pairings/approve": {
          status: 403,
          body: { error: "scope_escalation", missing: ["manage"] },
        },
      },
    });

    expect(await run(["approve", "123456", "--scopes", "manage"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("scope_escalation");
  });

  test("pair prints the code and the exact approve line to run next", async () => {
    const h = harness({ routes: { "POST /v1/pair": { body: { code: "424242" } } } });

    expect(await run(["pair", "phone", "--scopes", "read,prompt"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("424242");
    expect(h.stdout()).toContain("ompd approve 424242 --scopes read,prompt");
    // Pairing is unauthenticated by design; sending a token here would imply
    // the request needed one.
    expect(h.calls[0]?.authorization).toBeNull();
  });

  test("prints reachable endpoints under the token, grouped by reach", async () => {
    const h = harness({
      routes: {
        "POST /v1/pairings/approve": { body: { token: "tok_x" } },
        "GET /v1/endpoints": {
          body: {
            offers: [
              {
                endpoint: { transport: "direct", url: "ws://10.4.1.221:7777/v1/socket" },
                reach: "same-network",
                note: "reachable from this Wi-Fi",
              },
              {
                endpoint: { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "dmn_1" },
                reach: "anywhere",
                note: "reachable from anywhere the hub is",
              },
            ],
          },
        },
      },
    });

    expect(await run(["approve", "123456", "--scopes", "read"], h.ctx)).toBe(0);
    const out = h.stdout();
    expect(out).toContain("same-network");
    expect(out).toContain("ws://10.4.1.221:7777/v1/socket");
    expect(out).toContain("reachable from this Wi-Fi");
    expect(out).toContain("anywhere");
    expect(out).toContain("wss://hub.example.com (daemon dmn_1)");
    expect(out).toContain("reachable from anywhere the hub is");
    // Token and endpoints are printed as two separate things, and the line
    // between them says which one is the secret.
    expect(out).toContain("the token above is a secret; the endpoints below are not");
  });

  test("a failed endpoints lookup never costs the token, which cannot be produced again", async () => {
    const h = harness({
      routes: {
        "POST /v1/pairings/approve": { body: { token: "tok_irrecoverable" } },
        "GET /v1/endpoints": { status: 500, body: { error: "boom" } },
      },
    });

    expect(await run(["approve", "123456", "--scopes", "read"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("tok_irrecoverable");
    expect(h.stderr()).toContain("could not list reachable endpoints");
  });

  test("prints a scannable QR bundle when the daemon returns the pairing's name", async () => {
    const h = harness({
      routes: {
        "POST /v1/pairings/approve": { body: { token: "tok_scan_me", name: "phone" } },
        "GET /v1/endpoints": {
          body: {
            offers: [
              {
                endpoint: { transport: "direct", url: "ws://10.4.1.221:7777/v1/socket" },
                reach: "same-network",
                note: "reachable from this Wi-Fi",
              },
            ],
          },
        },
      },
    });

    expect(await run(["approve", "123456", "--scopes", "read,prompt"], h.ctx)).toBe(0);
    const out = h.stdout();
    // Scannable ASCII art, not just the fallback text below it.
    expect(out).toContain("█");
    const fallback = out.split("\n").find((line) => line.trim().startsWith(BUNDLE_PREFIX));
    expect(fallback).toBeDefined();
    expect(parsePairingBundle((fallback ?? "").trim())).toEqual({
      v: 1,
      label: "phone",
      connection: {
        transport: "direct",
        url: "ws://10.4.1.221:7777/v1/socket",
        token: "tok_scan_me",
        scopes: ["read", "prompt"],
      },
    });
  });

  test("skips the QR code, without failing, when the daemon omits the pairing's name", async () => {
    const h = harness({
      routes: { "POST /v1/pairings/approve": { body: { token: "tok_no_name" } } },
    });
    expect(await run(["approve", "123456", "--scopes", "read"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("did not return the pairing's name");
    expect(h.stdout()).not.toContain(BUNDLE_PREFIX);
  });
});

describe("invite", () => {
  test("mints a token that authenticates a later request, composing pair then approve", async () => {
    const h = harness({
      routes: {
        "POST /v1/pair": { body: { code: "778899" } },
        "POST /v1/pairings/approve": { body: { token: "tok_invited", name: "kitchen-tablet" } },
      },
    });

    expect(await run(["invite", "kitchen-tablet", "--scopes", "read,prompt"], h.ctx)).toBe(0);

    // pair first, unauthenticated; approve second, with the operator's own token.
    // This is the daemon-side property that keeps `invite` from being a
    // self-service grant: it is exactly the two calls `pair` and `approve`
    // make separately, not a shortcut around either check.
    expect(h.calls[0]).toMatchObject({
      url: "/v1/pair",
      method: "POST",
      body: { name: "kitchen-tablet" },
      authorization: null,
    });
    expect(h.calls[1]).toMatchObject({
      url: "/v1/pairings/approve",
      method: "POST",
      body: { code: "778899", scopes: ["read", "prompt"] },
      authorization: "Bearer tok_local",
    });
    expect(h.stdout()).toContain("tok_invited");

    // The token is not just printed: it is what the paired device would
    // present. A second harness, standing in for that device, proves it
    // actually authenticates rather than merely looking right on screen.
    const device = harness({
      token: "tok_invited",
      routes: { "GET /v1/agents": { body: { agents: [] } } },
    });
    expect(await run(["agents"], device.ctx)).toBe(0);
    expect(device.calls[0]?.authorization).toBe("Bearer tok_invited");
  });

  test("prints a QR block that decodes back to the minted token", async () => {
    const h = harness({
      routes: {
        "POST /v1/pair": { body: { code: "112233" } },
        "POST /v1/pairings/approve": { body: { token: "tok_qr" } },
        "GET /v1/endpoints": {
          body: {
            offers: [
              {
                endpoint: { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "dmn_9" },
                reach: "anywhere",
                note: "reachable from anywhere the hub is",
              },
            ],
          },
        },
      },
    });

    expect(await run(["invite", "phone", "--scopes", "read,prompt"], h.ctx)).toBe(0);
    const out = h.stdout();
    expect(out).toContain("█");
    const fallback = out.split("\n").find((line) => line.trim().startsWith(BUNDLE_PREFIX));
    expect(fallback).toBeDefined();
    expect(parsePairingBundle((fallback ?? "").trim())).toEqual({
      v: 1,
      label: "phone",
      connection: {
        transport: "hub",
        hubUrl: "wss://hub.example.com",
        daemonId: "dmn_9",
        token: "tok_qr",
        scopes: ["read", "prompt"],
      },
    });
  });

  test("surfaces the daemon's scope_escalation refusal instead of crashing", async () => {
    const h = harness({
      routes: {
        "POST /v1/pair": { body: { code: "445566" } },
        "POST /v1/pairings/approve": {
          status: 403,
          body: { error: "scope_escalation", missing: ["manage"] },
        },
      },
    });

    expect(await run(["invite", "phone", "--scopes", "manage"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("scope_escalation");
    expect(h.stdout()).not.toContain("tok_");
  });
});

describe("rotate", () => {
  test("prints the replacement once and says the old one is dead", async () => {
    const h = harness({
      routes: {
        "POST /v1/tokens/rotate": {
          body: { deviceId: "dev_local_operator", token: "tok_replacement", revoked: 1 },
        },
      },
    });

    expect(await run(["rotate"], h.ctx)).toBe(0);

    const printed = h.stdout();
    expect(printed.split("tok_replacement")).toHaveLength(2);
    expect(printed).toContain("shown once");
    expect(printed).toContain("dev_local_operator");
    // The reason a token with no expiry is acceptable: the operator has to be
    // told, in the moment, that the old value is already refused.
    expect(printed).toContain("stopped");
    expect(h.stderr()).not.toContain("tok_replacement");

    // No body field means "the credential I am presenting", which is the only
    // reading that cannot rotate the wrong device by accident.
    expect(h.calls[0]).toMatchObject({
      url: "/v1/tokens/rotate",
      method: "POST",
      body: {},
      authorization: "Bearer tok_local",
    });
  });

  test("--device names the device and is sent as one", async () => {
    const h = harness({
      routes: {
        "POST /v1/tokens/rotate": { body: { deviceId: "dev_phone", token: "tok_new", revoked: 1 } },
      },
    });

    expect(await run(["rotate", "--device", "dev_phone"], h.ctx)).toBe(0);
    expect(h.calls[0]?.body).toEqual({ deviceId: "dev_phone" });
    // Nothing was written on this machine, so the operator is told to carry it.
    expect(h.stdout()).toContain("Hand it to that device");
  });

  test("a rewritten token file is reported as the daemon reported it", async () => {
    // The CLI must not infer this. With OMPD_URL pointing elsewhere the local
    // token file belongs to a different daemon entirely.
    const h = harness({
      routes: {
        "POST /v1/tokens/rotate": {
          body: {
            deviceId: "dev_local_operator",
            token: "tok_new",
            revoked: 1,
            tokenPath: "/somewhere/.ompd/token",
          },
        },
      },
    });

    expect(await run(["rotate"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("/somewhere/.ompd/token");
  });

  test("a daemon that returns no token is an error, not a silent success", async () => {
    const h = harness({ routes: { "POST /v1/tokens/rotate": { body: { deviceId: "dev_x" } } } });

    expect(await run(["rotate"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("rotated nothing");
  });
});

describe("config", () => {
  test("set persists a validated value 0600 and says a restart is needed", async () => {
    const h = harness();
    expect(await run(["config", "set", "hubUrl", "wss://hub.example.com"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("set hubUrl");
    expect(h.stdout()).toContain("wss://hub.example.com");
    expect(h.stdout()).toContain("restart it to pick");

    const path = join(h.home, "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hubUrl: "wss://hub.example.com" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("set rejects a hubUrl that is not ws or wss, using the daemon's own message, and writes nothing", async () => {
    const h = harness();
    expect(await run(["config", "set", "hubUrl", "http://x"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("ws:// or wss:// URL");
    expect(existsSync(join(h.home, "config.json"))).toBe(false);
  });

  test("set preserves keys it did not touch", async () => {
    const h = harness();
    const path = join(h.home, "config.json");
    writeFileSync(path, JSON.stringify({ host: "0.0.0.0", port: 9999 }));

    expect(await run(["config", "set", "hubUrl", "wss://hub.example.com"], h.ctx)).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      host: "0.0.0.0",
      port: 9999,
      hubUrl: "wss://hub.example.com",
    });
  });

  test("set coerces port to a number and keepAwake to a boolean", async () => {
    const h = harness();
    const path = join(h.home, "config.json");

    expect(await run(["config", "set", "port", "8080"], h.ctx)).toBe(0);
    expect(await run(["config", "set", "keepAwake", "false"], h.ctx)).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ port: 8080, keepAwake: false });
  });

  test("set rejects a port that is not a number, as a usage error", async () => {
    const h = harness();
    expect(await run(["config", "set", "port", "not-a-port"], h.ctx)).toBe(2);
    expect(h.stderr()).toContain("port must be an integer, got not-a-port");
    expect(existsSync(join(h.home, "config.json"))).toBe(false);
  });

  test("set rejects an unknown key by name and lists the known ones", async () => {
    const h = harness();
    expect(await run(["config", "set", "bogus", "x"], h.ctx)).toBe(2);
    expect(h.stderr()).toContain("unknown config key bogus");
    expect(h.stderr()).toContain("host");
    expect(h.stderr()).toContain("hubUrl");
    expect(existsSync(join(h.home, "config.json"))).toBe(false);
  });

  test("get rejects an unknown key the same way set does", async () => {
    const h = harness();
    expect(await run(["config", "get", "bogus"], h.ctx)).toBe(2);
    expect(h.stderr()).toContain("unknown config key bogus");
  });

  test("get prints the effective value, defaults included, with nothing else on the line", async () => {
    const h = harness();
    expect(await run(["config", "get", "host"], h.ctx)).toBe(0);
    expect(h.stdout()).toBe("127.0.0.1");
  });

  test("get prints a value that was set, not the default", async () => {
    const h = harness();
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ host: "0.0.0.0" }));
    expect(await run(["config", "get", "host"], h.ctx)).toBe(0);
    expect(h.stdout()).toBe("0.0.0.0");
  });

  test("list marks which values came from the file and which are defaults", async () => {
    const h = harness();
    writeFileSync(join(h.home, "config.json"), JSON.stringify({ hubUrl: "wss://hub.example.com" }));

    expect(await run(["config"], h.ctx)).toBe(0);
    const out = h.stdout();
    expect(out).toContain("hubUrl");
    expect(out).toContain("wss://hub.example.com");
    expect(out).toMatch(/hubUrl\s+wss:\/\/hub\.example\.com\s+file/);
    expect(out).toMatch(/host\s+127\.0\.0\.1\s+default/);
  });
});

describe("install and uninstall", () => {
  function writeForeignPlist(home: string): string {
    const path = join(home, "Library", "LaunchAgents", "ai.ompctl.plist");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<plist><dict><key>Label</key><string>someone.else</string></dict></plist>");
    return path;
  }

  /**
   * A binary at the default prefix, which is inside the harness's temp HOME
   * and therefore outside any checkout. Its contents do not matter: the plist
   * only needs a path that exists and is executable.
   */
  function installBinary(home: string): string {
    const prefix = join(home, ".local", "bin");
    mkdirSync(prefix, { recursive: true });
    const path = join(prefix, "ompd");
    writeFileSync(path, `#!/bin/sh\necho 0.1.0\n${BINARY_MARKER}\n`, { mode: 0o755 });
    return path;
  }

  test("refuses to clobber a plist ompd did not write", async () => {
    const h = harness();
    installBinary(h.home);
    const path = writeForeignPlist(h.home);
    const before = readFileSync(path, "utf8");

    expect(await run(["install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("ompd did not write it");
    expect(h.stderr()).toContain(PLIST_MARKER);
    // The file is untouched and launchctl was never asked to do anything.
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(h.commands).toHaveLength(0);
  });

  test("uninstall refuses the same file", async () => {
    const h = harness();
    const path = writeForeignPlist(h.home);

    expect(await run(["uninstall"], h.ctx)).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(h.commands).toHaveLength(0);
  });

  test("refuses to point a launch agent into a checkout", async () => {
    // No installed binary, so the only candidate left is this source tree.
    // launchd would hold that path across every login, and a linked worktree
    // stops existing the moment its branch is done.
    const h = harness();

    expect(await run(["install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("refusing to install a launch agent");
    expect(h.stderr()).toContain("ompd self-install");
    expect(existsSync(plistPath(h.ctx))).toBe(false);
    expect(h.commands).toHaveLength(0);
  });

  test("--allow-source-path installs anyway, and says what it did", async () => {
    const h = harness();

    expect(await run(["install", "--allow-source-path"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("inside the checkout at");
    expect(readFileSync(plistPath(h.ctx), "utf8")).toContain("main.ts");
  });

  test("install names the installed binary, not the source tree", async () => {
    const h = harness();
    const binary = installBinary(h.home);
    const path = plistPath(h.ctx);

    expect(await run(["install"], h.ctx)).toBe(0);
    const plist = readFileSync(path, "utf8");
    expect(plist).toContain(`<key>${PLIST_MARKER}</key>`);
    expect(plist).toContain("<string>ai.ompctl</string>");
    expect(plist).toContain("start");
    expect(plist).toContain("--foreground");
    // The daemon launchd starts must use the same state directory this CLI does.
    expect(plist).toContain(h.home);

    // The point of the whole exercise: one program argument, and it is the
    // installed binary. No bun, no `.ts` entry, nothing under a worktree.
    expect(programArguments(plist)).toEqual([binary, "start", "--foreground"]);
    expect(plist).toContain(`<key>${PLIST_PROGRAM_KEY}</key>`);
    expect(plistProgram(plist)).toBe(binary);
    expect(plist).not.toContain("main.ts");

    expect(h.stdout()).toContain(`runs    ${binary}`);
    expect(h.commands).toEqual([["launchctl", "load", path]]);
  });

  test("the working directory outlives the checkout too", async () => {
    const h = harness();
    installBinary(h.home);
    // launchd chdirs before it execs. A cwd inside a worktree fails the job
    // just as silently as a program inside one, and the cwd is the field
    // nobody thinks to check.
    h.ctx.cwd = "/tmp/some-scratch-tree-that-will-be-deleted";

    expect(await run(["install"], h.ctx)).toBe(0);
    const plist = readFileSync(plistPath(h.ctx), "utf8");
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${h.home}</string>`);
    expect(plist).not.toContain("some-scratch-tree");
  });

  test("--prefix picks a different installed binary", async () => {
    const h = harness();
    const prefix = join(h.home, "opt", "bin");
    mkdirSync(prefix, { recursive: true });
    const binary = join(prefix, "ompd");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });

    expect(await run(["install", "--prefix", prefix], h.ctx)).toBe(0);
    expect(plistProgram(readFileSync(plistPath(h.ctx), "utf8"))).toBe(binary);
  });

  test("install is idempotent and reloads rather than stacking", async () => {
    const h = harness();
    installBinary(h.home);
    const path = plistPath(h.ctx);

    await run(["install"], h.ctx);
    expect(await run(["install"], h.ctx)).toBe(0);

    // The second install unloads the old definition first. Rewriting the file
    // without that leaves the previous arguments running.
    expect(h.commands).toEqual([
      ["launchctl", "load", path],
      ["launchctl", "unload", path],
      ["launchctl", "load", path],
    ]);
    expect(h.stdout()).toContain("reinstalled");
  });

  test("uninstall removes what install wrote, and doing it twice is fine", async () => {
    const h = harness();
    installBinary(h.home);
    const path = plistPath(h.ctx);

    await run(["install"], h.ctx);
    expect(await run(["uninstall"], h.ctx)).toBe(0);
    expect(existsSync(path)).toBe(false);

    expect(await run(["uninstall"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("nothing to uninstall");
  });

  test("a failed launchctl load is reported rather than claimed as success", async () => {
    const h = harness({ execCode: 1 });
    installBinary(h.home);
    expect(await run(["install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("launchctl load failed");
  });
});

describe("reads and writes over the API", () => {
  test("agents lists what the daemon returns", async () => {
    const h = harness({
      routes: {
        "GET /v1/agents": {
          body: {
            agents: [
              {
                id: "agt_1",
                name: "build",
                state: "busy",
                cwd: "/tmp/repo",
                createdAt: new Date().toISOString(),
                lastActiveAt: new Date().toISOString(),
                host: { kind: "local", id: "1", spec: { kind: "local" } },
                labels: {},
              },
            ],
          },
        },
      },
    });

    expect(await run(["agents"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("agt_1");
    expect(h.stdout()).toContain("busy");
  });

  test("an empty list says so instead of printing a bare header", async () => {
    const h = harness({ routes: { "GET /v1/agents": { body: { agents: [] } } } });
    await run(["agents"], h.ctx);
    expect(h.stdout()).toBe("no agents");
  });

  test("new resolves a relative cwd against the shell, not the daemon", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: {
            agent: {
              id: "agt_2",
              name: "sub",
              state: "idle",
              cwd: "/resolved",
              createdAt: "",
              lastActiveAt: "",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              labels: {},
            },
          },
        },
      },
    });

    await run(["new", "sub"], h.ctx);
    // A daemon started by launchd runs from `/`; a relative path would land
    // somewhere nobody meant.
    expect(h.calls[0]?.body).toEqual({ name: "sub", cwd: join(h.home, "sub") });
  });

  test("new --container sends the host spec, and prints the effective mounts back", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: {
            agent: {
              id: "agt_3",
              name: "sandboxed",
              state: "provisioning",
              cwd: "/tmp/repo",
              createdAt: "",
              lastActiveAt: "",
              host: {
                kind: "container",
                id: "cnt_1",
                spec: {
                  kind: "container",
                  image: "ghcr.io/example/omp:1",
                  // The daemon fills in the default mode before handing this back.
                  mounts: [{ hostPath: "/data", mode: "ro" }, { hostPath: "/tools", mode: "rw" }],
                },
              },
              labels: {},
            },
          },
        },
      },
    });

    const code = await run(
      [
        "new",
        "/tmp/repo",
        "--name",
        "sandboxed",
        "--container",
        "--image",
        "ghcr.io/example/omp:1",
        "--mounts",
        "/data,/tools:rw",
      ],
      h.ctx,
    );
    expect(code).toBe(0);
    expect(h.calls[0]?.body).toEqual({
      name: "sandboxed",
      cwd: "/tmp/repo",
      host: {
        kind: "container",
        image: "ghcr.io/example/omp:1",
        mounts: [{ hostPath: "/data" }, { hostPath: "/tools", mode: "rw" }],
      },
    });
    expect(h.stdout()).toContain("host    container cnt_1");
    expect(h.stdout()).toContain("/data (ro)");
    expect(h.stdout()).toContain("/tools (rw)");
  });

  test("status without a daemon exits non-zero and says how to start one", async () => {
    const h = harness();
    expect(await run(["status"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("ompd is not running");
    expect(h.stdout()).toContain("ompd start");
  });

  test("status reports uptime and agent states", async () => {
    const h = harness({
      routes: {
        "GET /v1/health": { body: { ok: true, version: "0.1.0" } },
        "GET /v1/status": {
          body: {
            version: "0.1.0",
            startedAt: "2026-01-01T00:00:00.000Z",
            uptimeMs: 3_661_000,
            agents: { total: 2, byState: { idle: 1, busy: 1 } },
          },
        },
      },
    });

    expect(await run(["status"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("1h 1m");
    expect(h.stdout()).toContain("agents       2 (busy 1, idle 1)");
  });

  test("status without a token still reports liveness, then asks for one", async () => {
    const h = harness({ token: null, routes: { "GET /v1/health": { body: { ok: true, version: "0.1.0" } } } });

    expect(await run(["status"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("ompd is running");
    expect(h.stderr()).toContain("No device token found");
  });

  test("a failed routine run exits non-zero", async () => {
    const h = harness({
      routes: {
        "POST /v1/routines/rt_1/run": {
          body: { run: { id: "run_1", routineId: "rt_1", state: "failed", startedAt: "", error: "boom" } },
        },
      },
    });

    expect(await run(["run", "rt_1"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("boom");
  });

  test("audit passes its limit through", async () => {
    const h = harness({ routes: { "GET /v1/audit?limit=7": { body: { entries: [] } } } });
    expect(await run(["audit", "--limit", "7"], h.ctx)).toBe(0);
    expect(h.calls[0]?.url).toBe("/v1/audit?limit=7");
  });

  test("revoke and stop-agent url-encode their argument", async () => {
    const h = harness({
      routes: {
        "DELETE /v1/devices/dev%2F1": { body: { ok: true } },
        "DELETE /v1/agents/agt%2F1": { body: { ok: true } },
      },
    });

    await run(["revoke", "dev/1"], h.ctx);
    await run(["stop-agent", "agt/1"], h.ctx);
    expect(h.calls.map((call) => call.url)).toEqual(["/v1/devices/dev%2F1", "/v1/agents/agt%2F1"]);
  });

  test("prompt posts the text and prints only the stop reason", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents/agt_1/prompt": { body: { agentId: "agt_1", stopReason: "end_turn" } },
      },
    });

    expect(await run(["prompt", "agt_1", "ship it"], h.ctx)).toBe(0);
    expect(h.calls[0]?.body).toEqual({ text: "ship it" });
    // A script reads this. Anything else on stdout would have to be parsed off.
    expect(h.stdout()).toBe("end_turn");
  });

  test("prompt url-encodes the agent id and reports a daemon refusal", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents/agt%2F1/prompt": { body: { error: "forbidden" }, status: 403 },
      },
    });

    expect(await run(["prompt", "agt/1", "hi"], h.ctx)).toBe(1);
    expect(h.calls[0]?.url).toBe("/v1/agents/agt%2F1/prompt");
    expect(h.stderr()).toContain("forbidden");
  });
});

describe("finding a checkout", () => {
  test("a linked worktree's .git is a FILE, and still marks a checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "ompd-wt-"));
    scratch.push(root);
    // This is the exact shape `git worktree add` leaves behind, and the exact
    // case an `isDirectory` check waves through. It is also the shape ompd is
    // developed in, so getting it wrong means the bug never shows up here.
    writeFileSync(join(root, ".git"), "gitdir: /somewhere/.git/worktrees/feature\n");
    const nested = join(root, "packages", "cli", "src");
    mkdirSync(nested, { recursive: true });

    expect(findCheckoutRoot(nested)).toBe(root);
  });

  test("an ordinary clone's .git is a directory, and marks one too", () => {
    const root = mkdtempSync(join(tmpdir(), "ompd-clone-"));
    scratch.push(root);
    mkdirSync(join(root, ".git"));

    expect(findCheckoutRoot(root)).toBe(root);
  });

  test("somewhere with no .git above it is not a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompd-bare-"));
    scratch.push(dir);

    expect(findCheckoutRoot(dir)).toBeNull();
  });
});

describe("self-install", () => {
  /**
   * Answer the two commands `self-install` runs: the compile, by writing a
   * plausible binary where it asked, and the version probe of what it just
   * installed.
   */
  function compiler(version = "0.1.0"): (command: string[]) => ExecResult | undefined {
    return (command) => {
      if (command[1] === "build") {
        writeFileSync(String(command[4]), `binary bytes ${BINARY_MARKER} more bytes\n`);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "--version") return { code: 0, stdout: `${version}\n`, stderr: "" };
      return undefined;
    };
  }

  test("refuses a file at the target that ompd did not build", async () => {
    const h = harness({ onExec: compiler() });
    const prefix = join(h.home, ".local", "bin");
    mkdirSync(prefix, { recursive: true });
    const target = join(prefix, "ompd");
    writeFileSync(target, "#!/bin/sh\necho someone else's tool\n");

    expect(await run(["self-install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("ompd did not build it");
    expect(h.stderr()).toContain(BINARY_MARKER);
    // Untouched, and nothing was compiled on the way to refusing.
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho someone else's tool\n");
    expect(h.commands).toHaveLength(0);
  });

  test("installs to ~/.local/bin, reports the path and version, and is executable", async () => {
    const h = harness({ onExec: compiler("9.9.9") });
    const target = join(h.home, ".local", "bin", "ompd");

    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(h.stdout()).toContain("installed ompd 9.9.9");
    expect(h.stdout()).toContain(target);
  });

  test("running it twice replaces its own binary without complaint", async () => {
    const h = harness({ onExec: compiler() });

    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(h.stderr()).toBe("");
  });

  test("a compile that fails leaves nothing behind", async () => {
    const h = harness({
      onExec: (command) =>
        command[1] === "build" ? { code: 1, stdout: "", stderr: "error: boom" } : undefined,
    });

    expect(await run(["self-install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("error: boom");
    expect(existsSync(join(h.home, ".local", "bin", "ompd"))).toBe(false);
  });

  test("a prefix already on PATH is reported as needing no edit", async () => {
    const prefix = join(mkdtempSync(join(tmpdir(), "ompd-path-")), "bin");
    scratch.push(dirname(prefix));
    const h = harness({
      onExec: compiler(),
      env: { PATH: `${prefix}:/usr/bin`, SHELL: "/bin/zsh" },
    });

    expect(await run(["self-install", "--prefix", prefix], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("already on your PATH; nothing to edit");
    expect(h.stdout()).not.toContain("export PATH");
  });

  test("a prefix off PATH names the rc file for this shell and the exact line", async () => {
    const h = harness({
      onExec: compiler(),
      env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    });
    const prefix = join(h.home, ".local", "bin");

    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain(`${prefix} is not on your PATH`);
    expect(h.stdout()).toContain(join(h.home, ".zshrc"));
    expect(h.stdout()).toContain(`export PATH="${prefix}:$PATH"`);
  });

  test("fish gets fish syntax, not a broken export line", async () => {
    const h = harness({
      onExec: compiler(),
      env: { PATH: "/usr/bin", SHELL: "/usr/local/bin/fish" },
    });
    const prefix = join(h.home, ".local", "bin");

    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain(join(h.home, ".config", "fish", "config.fish"));
    expect(h.stdout()).toContain(`fish_add_path ${prefix}`);
  });

  test("an ompd earlier on PATH is called out, because it wins", async () => {
    const h = harness({ onExec: compiler() });
    const prefix = join(h.home, ".local", "bin");
    const shadow = join(h.home, "shadow");
    mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, "ompd"), "#!/bin/sh\n", { mode: 0o755 });
    h.ctx.env.PATH = `${shadow}:${prefix}`;

    expect(await run(["self-install"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain(`${join(shadow, "ompd")} comes first`);
  });
});

describe("doctor", () => {
  test("a daemon that is down is a failure with the command that fixes it", async () => {
    const h = harness();

    expect(await run(["doctor"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("FAIL daemon");
    expect(h.stdout()).toContain("/v1/health");
    expect(h.stdout()).toContain("run: ompd start");
  });

  test("no binary on PATH is a failure that names self-install", async () => {
    const h = harness({ env: { PATH: "/nowhere" } });

    expect(await run(["doctor"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("FAIL binary");
    expect(h.stdout()).toContain("self-install");
  });

  test("a login agent pointing at a path that is gone is a failure, not a warning", async () => {
    const h = harness({ routes: healthy(), onExec: reportsVersion() });
    installedBinary(h);
    const plist = plistPath(h.ctx);
    mkdirSync(dirname(plist), { recursive: true });
    // Exactly what a removed worktree leaves behind: a loadable plist whose
    // program vanished. launchd retries this at every login and says nothing.
    writeFileSync(
      plist,
      `<key>${PLIST_MARKER}</key><string>1</string>\n` +
        `<key>${PLIST_PROGRAM_KEY}</key><string>/gone/ompd.worktrees/foundation/ompd</string>`,
    );

    expect(await run(["doctor"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("FAIL login agent");
    expect(h.stdout()).toContain("no longer exists");
    expect(h.stdout()).toContain("ompd self-install && ompd install");
  });

  test("a token the daemon rejects is a failure that says what to run", async () => {
    const h = harness({
      routes: { "GET /v1/health": { body: { ok: true, version: OMPD_VERSION } } },
      onExec: reportsVersion(),
    });
    installedBinary(h);

    // /v1/status is unrouted, so it 404s: a token the daemon will not honour.
    expect(await run(["doctor"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("FAIL token");
    expect(h.stdout()).toContain("ompd rotate");
  });

  test("a healthy machine passes and exits zero", async () => {
    const h = harness({ routes: healthy(), onExec: reportsVersion() });
    installedBinary(h);
    chmodSync(join(h.home, "token"), 0o600);

    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("ok   binary");
    expect(h.stdout()).toContain("ok   daemon");
    expect(h.stdout()).toContain("ok   token");
    expect(h.stdout()).toContain("cli, binary, daemon all on");
    expect(h.stdout()).toContain("stay awake");
    expect(h.stdout()).not.toContain("FAIL");
  });

  test("a version skew between the daemon and the binary is called out", async () => {
    const h = harness({
      routes: {
        "GET /v1/health": { body: { ok: true, version: "0.0.9" } },
        "GET /v1/status": { body: { version: "0.0.9" } },
      },
      onExec: reportsVersion(),
    });
    installedBinary(h);
    chmodSync(join(h.home, "token"), 0o600);

    // Stale rather than broken: the exit code stays zero and the line says so.
    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("warn versions");
    expect(h.stdout()).toContain("daemon 0.0.9");
  });

  test("a world-readable token is a failure with the chmod to run", async () => {
    const h = harness({ routes: healthy(), onExec: reportsVersion() });
    installedBinary(h);
    chmodSync(join(h.home, "token"), 0o644);

    expect(await run(["doctor"], h.ctx)).toBe(1);
    expect(h.stdout()).toContain("FAIL state dir");
    expect(h.stdout()).toContain(`run: chmod 600 ${join(h.home, "token")}`);
  });

  /** The installed binary answering `--version`, as a real one would. */
  function reportsVersion(version = OMPD_VERSION): (command: string[]) => ExecResult | undefined {
    return (command) =>
      command[1] === "--version" ? { code: 0, stdout: `${version}\n`, stderr: "" } : undefined;
  }

  function healthy(): NonNullable<HarnessOptions["routes"]> {
    return {
      "GET /v1/health": { body: { ok: true, version: OMPD_VERSION } },
      "GET /v1/status": { body: { version: OMPD_VERSION } },
    };
  }

  /** Put an `ompd` on PATH that answers `--version` with the current one. */
  function installedBinary(h: Harness): string {
    const prefix = join(h.home, ".local", "bin");
    mkdirSync(prefix, { recursive: true });
    const target = join(prefix, "ompd");
    writeFileSync(target, `#!/bin/sh\n${BINARY_MARKER}\n`, { mode: 0o755 });
    h.ctx.env.PATH = prefix;
    return target;
  }
});
