/**
 * Everything the commands share: where the daemon is, what token to present,
 * and how a failed request turns into something an operator can act on.
 *
 * The rule this file exists to enforce is that no command reads the SQLite
 * store. A running daemon is the only writer, and a second process reading its
 * database would see pairing state that lives in the daemon's memory not at
 * all. Every command goes over HTTP or it does not happen.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { endpointPath, loadConfig, type Ompd, type OmpdOptions } from "@ompd/daemon";

/** Raised when a command needs a token and there is none to present. */
export class TokenMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenMissingError";
  }
}

/** Raised when the daemon is not listening where the CLI looked. */
export class DaemonUnreachableError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`no daemon is listening at ${url}: ${cause instanceof Error ? cause.message : cause}`);
    this.name = "DaemonUnreachableError";
    this.url = url;
  }
}

/** Raised when the daemon answered and the answer was a refusal. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Everything a command touches that is not pure computation.
 *
 * Collected into one injected object so the whole CLI runs in a test without a
 * daemon, a home directory, or a real clock.
 */
export interface CliContext {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** State directory, `~/.ompd` in production. */
  home: string;
  /**
   * Narrower than `typeof fetch` on purpose: this is all the CLI uses, and a
   * test double should not have to implement the parts it does not.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs an external binary. Only `launchctl` uses it. */
  exec: (command: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Builds the daemon `ompd start --foreground` runs. Defaulted rather than
   * required so a test can drive `start` without binding a port or spawning a
   * host.
   */
  createDaemon?: (opts: OmpdOptions) => Ompd;
}

export function defaultContext(): CliContext {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    home: process.env.OMPD_HOME ?? join(homedir(), ".ompd"),
    fetch: (input, init) => fetch(input, init),
    exec: async (command) => {
      const [bin, ...args] = command;
      const proc = Bun.spawn([bin as string, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}

/**
 * How to get a token, without the first line claiming anything about why it
 * is needed. Both callers below supply that themselves, because "there was no
 * token" and "the daemon refused the one you have" are different problems and
 * telling someone the wrong one sends them looking in the wrong place.
 */
const HOW_TO_GET_A_TOKEN =
  "  Run `ompd start` on this machine: it mints a local operator token at ~/.ompd/token.\n" +
  "  Already running elsewhere? Pair this shell with `ompd pair <name>`, approve the code\n" +
  "  from a device that holds the approve scope, and export OMPD_TOKEN with the result.";

export const TOKEN_GUIDANCE = `No device token found.\n${HOW_TO_GET_A_TOKEN}`;

export const TOKEN_REJECTED_GUIDANCE =
  "the daemon rejected this token. Tokens survive a restart, so this is not that:\n" +
  "  it was revoked, rotated, or belongs to another daemon than this shell is\n" +
  "  pointing at.\n" +
  HOW_TO_GET_A_TOKEN;

/**
 * The address the running daemon published, if there is one.
 *
 * Written at `listen` and removed at `stop`. A file left behind by a daemon
 * that was killed points at a dead port, which is the right failure: the next
 * command reports "not running" instead of silently talking to whatever else
 * has since taken that port from the config file.
 */
export function readEndpoint(home: string): string | null {
  const path = endpointPath(home);
  if (!existsSync(path)) return null;
  const url = readFileSync(path, "utf8").trim();
  return url.length > 0 ? url : null;
}

/**
 * Where the daemon is.
 *
 * `OMPD_URL` wins, so a shell can be pointed anywhere. Then the endpoint file,
 * because a daemon started with `--port` or `--port 0` is listening somewhere
 * the config file has never heard of and the next command still has to find
 * it. Config last, which is where it will be on a plain start.
 */
export function resolveBaseUrl(ctx: CliContext): string {
  const override = ctx.env.OMPD_URL;
  if (override !== undefined && override.length > 0) return override.replace(/\/+$/, "");

  const published = readEndpoint(ctx.home);
  if (published !== null) return published.replace(/\/+$/, "");

  const config = loadConfig(ctx.home);
  return `http://${config.host}:${config.port}`;
}

/** `OMPD_TOKEN`, else `<home>/token`, else null. */
export function resolveToken(ctx: CliContext): string | null {
  const fromEnv = ctx.env.OMPD_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

  const path = join(ctx.home, "token");
  if (!existsSync(path)) return null;
  const contents = readFileSync(path, "utf8").trim();
  return contents.length > 0 ? contents : null;
}

export function requireToken(ctx: CliContext): string {
  const token = resolveToken(ctx);
  if (token === null) throw new TokenMissingError(TOKEN_GUIDANCE);
  return token;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Unauthenticated routes, which is only `/v1/health` and `/v1/pair`. */
  anonymous?: boolean;
}

/**
 * One request against the daemon, with its failures already translated.
 *
 * A refused connection, a 401, and a 500 are three different operator problems
 * and each gets its own error type here, so no command has to re-derive which
 * one it hit from a status code.
 */
export async function api<T>(ctx: CliContext, path: string, opts: RequestOptions = {}): Promise<T> {
  const base = resolveBaseUrl(ctx);
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.anonymous !== true) headers.set("authorization", `Bearer ${requireToken(ctx)}`);

  let response: Response;
  try {
    response = await ctx.fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new DaemonUnreachableError(base, err);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, `${path} returned ${response.status} and not JSON`);
    }
  }

  if (!response.ok) {
    // `in` narrows `parsed.error` to unknown, which is exactly what it is:
    // the daemon's error strings are the only thing read off this branch.
    const detail =
      parsed !== null && typeof parsed === "object" && "error" in parsed
        ? String(parsed.error)
        : `HTTP ${response.status}`;
    if (response.status === 401) {
      // Deliberately not the missing-token guidance: a token was found and
      // presented. Telling someone "no device token found" while they are
      // holding one sends them to look in the wrong place.
      throw new ApiError(401, TOKEN_REJECTED_GUIDANCE);
    }
    throw new ApiError(response.status, detail);
  }

  return parsed as T;
}
