/**
 * `ompd start` and `ompd status`.
 *
 * `start` is the only command that builds an `Ompd`. Everything else, `status`
 * included, goes over HTTP: a second process reading the SQLite file behind a
 * running daemon would miss every piece of state that lives in the daemon's
 * memory, and would be reading a database it is not the writer of.
 */

import { existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeEndpoint, type EndpointOffer } from "@ompd/core/pairing";
import {
  endpointPath,
  ensureHome,
  homeIdFor,
  loadConfig,
  Ompd,
  type OmpdOptions,
} from "@ompd/daemon";
import type { Command } from "../args.ts";
import {
  api,
  readEndpoint,
  resolveBaseUrl,
  resolveToken,
  TOKEN_GUIDANCE,
  type CliContext,
} from "../client.ts";
import { duration } from "../format.ts";
import { selfExec } from "../install.ts";
import { fetchEndpointOffers } from "./devices.ts";

/** How long a backgrounded start waits for its child to answer `/v1/health`. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;

/**
 * The first words of the daemon's own banner.
 *
 * A backgrounded child writes its banner to the log, and this process prints
 * one too. This is where the child's startup output stops being interesting.
 */
const BANNER_PREFIX = "ompd is listening at";

interface HealthResponse {
  ok?: boolean;
  version?: string;
  /** Identity of the state directory the responder serves. Absent on old daemons. */
  homeId?: string;
}

interface StatusResponse {
  version?: string;
  startedAt?: string;
  uptimeMs?: number;
  agents?: { total?: number; byState?: Record<string, number> };
}

/** What answered a health probe, and whether it is the daemon for this home. */
export type Liveness =
  | { kind: "none" }
  | { kind: "ours"; health: HealthResponse }
  | { kind: "foreign"; health: HealthResponse };

/**
 * Probe `/v1/health` and decide whose daemon answered.
 *
 * The distinction is the whole point. Treating any healthy listener as our own
 * is what made `ompd start` print "already listening" and exit 0 while the
 * operator's commands went to a different daemon with a different token.
 *
 * A responder with no `homeId` predates this and cannot prove anything, so it
 * is foreign: refusing to start beside an unidentifiable daemon is recoverable,
 * and adopting one silently is not.
 */
async function probe(ctx: CliContext, base: string): Promise<Liveness> {
  let body: HealthResponse;
  try {
    const response = await ctx.fetch(`${base}/v1/health`);
    if (!response.ok) return { kind: "none" };
    body = (await response.json()) as HealthResponse;
  } catch {
    return { kind: "none" };
  }
  return body.homeId === homeIdFor(ctx.home)
    ? { kind: "ours", health: body }
    : { kind: "foreign", health: body };
}

/** True once something answers `/v1/health` at `base`, whoever it belongs to. */
async function health(ctx: CliContext, base: string): Promise<HealthResponse | null> {
  const live = await probe(ctx, base);
  return live.kind === "none" ? null : live.health;
}

/**
 * What a device is told at startup, built from what the daemon actually bound.
 *
 * This used to print `${url} is loopback` unconditionally. Started with
 * `--host 0.0.0.0` it therefore called a daemon that was published to the whole
 * network private, which is the one sentence in this output nobody can afford
 * to have wrong. It also offered `0.0.0.0` as a URL to open on a phone, and
 * that is a bind sentinel rather than a destination: it means "every
 * interface" to a listening socket and nothing at all to a browser.
 *
 * So the reachable set comes from the daemon rather than from string surgery
 * on the bind address, and the security sentence follows what that set says.
 */
function pairingInstructions(url: string, tokenPath: string, offers: readonly EndpointOffer[]): string[] {
  const sameNetwork = offers.filter((offer) => offer.reach === "same-network");
  const anywhere = offers.filter((offer) => offer.reach === "anywhere");
  const lines = [
    `  bound at     ${url} (the address it listens on, not necessarily one to open)`,
    `  token        ${tokenPath} (local operator, mode 0600)`,
    "",
    "  pair a phone:",
    "    ompd pair <name> --scopes read,prompt",
    "    ompd approve <code> --scopes read,prompt",
    "  approve prints the token once, and the endpoints below beside it.",
    "  or, from this machine, in one step:",
    "    ompd invite <name> --scopes read,prompt",
    "",
  ];

  if (sameNetwork.length === 0 && anywhere.length === 0) {
    lines.push(
      "  Bound to loopback, so nothing off this machine can reach it. Set a reachable",
      "  address with `ompd config set host <address>`, or a hub with",
      "  `ompd config set hubUrl wss://<host>`, and restart.",
    );
    return lines;
  }

  if (sameNetwork.length > 0) {
    lines.push(
      "  Reachable from this network at:",
      ...sameNetwork.map((offer) => `    ${describeEndpoint(offer.endpoint)}`),
      "  Anything that can reach those addresses can ask this daemon to run code as",
      "  you, and only a paired token stands in front of it.",
    );
  }
  if (anywhere.length > 0) {
    lines.push(
      "  Reachable from anywhere through:",
      ...anywhere.map((offer) => `    ${describeEndpoint(offer.endpoint)}`),
    );
  }
  return lines;
}

export async function startCommand(ctx: CliContext, cmd: Extract<Command, { kind: "start" }>): Promise<number> {
  const overrides: OmpdOptions["overrides"] = {};
  if (cmd.host !== undefined) overrides.host = cmd.host;
  if (cmd.port !== undefined) overrides.port = cmd.port;

  if (!cmd.foreground) return backgroundStart(ctx, cmd, overrides);

  const daemon = (ctx.createDaemon ?? ((opts: OmpdOptions) => new Ompd(opts)))({
    home: ctx.home,
    overrides,
    repoRoot: ctx.cwd,
    onLog: (line) => ctx.out(line),
  });

  // Armed before starting, not after. Startup probes speech engines, binds a
  // port, and writes a token file; a Ctrl-C during any of that would otherwise
  // hit the default handler and kill the process with the store open and the
  // socket half-bound. `stop` waits for an in-flight start, so an early signal
  // still unwinds in the right order.
  daemon.installSignalHandlers();

  const info = await daemon.start();
  ctx.out(`${BANNER_PREFIX} ${info.url}`);
  for (const line of pairingInstructions(info.url, daemon.tokenPath, info.endpoints)) ctx.out(line);

  // The daemon owns the process from here. Signal handlers call `stop` and
  // exit, so this never resolves on a normal run.
  const forever = Promise.withResolvers<void>();
  await forever.promise;
  return 0;
}

/**
 * Re-exec this CLI as a detached `start --foreground` and wait for it to answer.
 *
 * Returning before the daemon is listening would make `ompd start && ompd
 * agents` a race, which is the first thing anyone types. The child publishes
 * the address it actually bound, so this works even for `--port 0`, where the
 * OS picks and nobody could have predicted the answer.
 */
async function backgroundStart(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "start" }>,
  overrides: NonNullable<OmpdOptions["overrides"]>,
): Promise<number> {
  ensureHome(ctx.home);

  // The published endpoint first, and before anything is deleted. It is the
  // one answer to "is a daemon already serving this home", and it is the only
  // one that works for `--port 0`, where nobody could have predicted the
  // address. Removing the file before this check would erase a live daemon's
  // discovery record and then start a second one beside it.
  const published = readEndpoint(ctx.home);
  if (published !== null) {
    const live = await probe(ctx, published);
    if (live.kind === "ours") {
      ctx.out(`ompd is already listening at ${published}`);
      return 0;
    }
    if (live.kind === "foreign") {
      // Our endpoint file, someone else's daemon. Almost always a stale file
      // plus a recycled port, and adopting it would send every later command
      // to a daemon holding a different token.
      ctx.err(`${published} is served by a different ompd, not this one.`);
      ctx.err(`  that address came from ${endpointPath(ctx.home)}, which is stale`);
      ctx.err("  remove that file, or start elsewhere with `ompd start --port N`");
      return 1;
    }
  }

  // Then the address this command would bind, which catches a daemon that
  // came up without leaving a file, or anything else already on that port.
  const wanted = loadConfig(ctx.home, overrides);
  if (wanted.port !== 0) {
    const base = `http://${wanted.host}:${wanted.port}`;
    const live = await probe(ctx, base);
    if (live.kind === "ours") {
      ctx.out(`ompd is already listening at ${base}`);
      return 0;
    }
    if (live.kind === "foreign") {
      // The defect this replaced: any healthy listener counted as ours, so a
      // second daemon on the port made `ompd start` print success and exit 0
      // while the operator's commands went somewhere else entirely.
      ctx.err(`port ${wanted.port} is taken by a different ompd.`);
      ctx.err(`  this shell serves ${ctx.home}`);
      ctx.err("  start elsewhere with `ompd start --port N`, or stop the other daemon");
      return 1;
    }
  }

  // Nothing is serving, so any file here is from a daemon that is gone. Left
  // in place it would end the wait below before the child had bound anything.
  rmSync(endpointPath(ctx.home), { force: true });

  const logPath = join(ctx.home, "ompd.log");
  // Where the child's output will begin. Without this offset a first start
  // says nothing about having minted the local operator device, because that
  // message goes to the log the child is writing rather than to this terminal.
  const logFrom = existsSync(logPath) ? statSync(logPath).size : 0;
  const log = openSync(logPath, "a");
  // `selfExec` and not a hardcoded entry file: an installed binary re-execs
  // itself, and a `.ts` path resolved from this module does not exist inside
  // one. Getting this wrong makes `ompd start` work in the repo and nowhere
  // else, which is the failure this whole release is about.
  const args = [...selfExec(), "start", "--foreground"];
  if (cmd.host !== undefined) args.push("--host", cmd.host);
  if (cmd.port !== undefined) args.push("--port", String(cmd.port));

  const child = Bun.spawn(args, {
    cwd: ctx.cwd,
    env: { ...ctx.env, OMPD_HOME: ctx.home },
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  // Detached: the daemon outlives the shell that started it, which is the
  // entire difference between this and `--foreground`.
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const published = readEndpoint(ctx.home);
    // Both conditions: the file says where, and the port there answers. The
    // file alone would report success a moment before the daemon could serve.
    if (published !== null && (await health(ctx, published)) !== null) {
      for (const line of startupLines(logPath, logFrom)) ctx.out(line);
      ctx.out(`${BANNER_PREFIX} ${published}`);
      for (const line of pairingInstructions(
        published,
        join(ctx.home, "token"),
        (await fetchEndpointOffers(ctx)) ?? [],
      )) {
        ctx.out(line);
      }
      ctx.out("");
      ctx.out(`  logs         ${logPath}`);
      return 0;
    }
    if (child.exitCode !== null) {
      ctx.err(`the daemon exited with code ${child.exitCode} before it started listening.`);
      ctx.err(`Check ${logPath}.`);
      return 1;
    }
    await Bun.sleep(READY_POLL_MS);
  }

  ctx.err(`the daemon did not start listening within ${duration(READY_TIMEOUT_MS)}.`);
  ctx.err(`Check ${logPath}.`);
  return 1;
}

/**
 * What the child said before it started serving.
 *
 * Its own banner is dropped, because this process prints one and the operator
 * should not read it twice. What is left is the part only the daemon knows:
 * that it minted the local operator device, and which speech engines it found.
 */
export function startupLines(logPath: string, from: number): string[] {
  if (!existsSync(logPath)) return [];
  const lines: string[] = [];
  // Sliced as bytes, because `from` came from `statSync().size`. Decoding
  // first and slicing by string index drifts on any non-ASCII the daemon
  // logged, and one accented character in a home directory is enough to make
  // the first line of real output come out truncated.
  const written = readFileSync(logPath).subarray(from).toString("utf8");
  for (const line of written.split("\n")) {
    if (line.startsWith(BANNER_PREFIX)) break;
    if (line.trim().length > 0) lines.push(line);
  }
  return lines;
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  const base = resolveBaseUrl(ctx);
  const live = await health(ctx, base);
  if (live === null) {
    ctx.out(`ompd is not running (nothing answered ${base}/v1/health)`);
    ctx.out("  start it with `ompd start`");
    return 1;
  }

  ctx.out(`ompd is running at ${base}`);

  // Liveness needed no token. The detail does, and a missing one is worth
  // reporting as itself rather than as a failed status command.
  if (resolveToken(ctx) === null) {
    ctx.out(`  version      ${live.version ?? "unknown"}`);
    ctx.out("");
    ctx.err(TOKEN_GUIDANCE);
    return 1;
  }

  const status = await api<StatusResponse>(ctx, "/v1/status");
  const byState = status.agents?.byState ?? {};
  const states = Object.entries(byState)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `${state} ${count}`);

  ctx.out(`  version      ${status.version ?? live.version ?? "unknown"}`);
  ctx.out(`  uptime       ${duration(status.uptimeMs ?? 0)} (since ${status.startedAt ?? "unknown"})`);
  ctx.out(`  agents       ${status.agents?.total ?? 0}${states.length > 0 ? ` (${states.join(", ")})` : ""}`);
  return 0;
}
