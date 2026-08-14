/**
 * Where the daemon is, and what token proves this shell may talk to it.
 *
 * Deliberately independent of `@ompd/daemon`: that package pulls in the
 * provisioner, the evolution engine, and the voice bridge, none of which a
 * client needs. This mirrors exactly the three files ompd itself writes
 * (`endpoint`, `token`, `config.json` under `~/.ompd`) and the same
 * `OMPD_URL`/`OMPD_TOKEN` env overrides `control-plane/packages/cli` honours,
 * so a shell configured for one client works unchanged for this one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_OMPD_PORT = 7777;

function defaultHome(): string {
  return path.join(os.homedir(), ".ompd");
}

function readTrimmed(filePath: string): string | null {
  try {
    const contents = fs.readFileSync(filePath, "utf8").trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

export interface ResolveDaemonAddressOptions {
  /** `~/.ompd` unless overridden, e.g. by `OMPD_HOME` for a test daemon. */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Base HTTP URL for the daemon: `OMPD_URL`, else the address the daemon
 * actually published at `listen` (`<home>/endpoint`, present only while it is
 * running), else the configured host/port with no daemon-liveness guarantee.
 */
export function resolveDaemonBaseUrl(options: ResolveDaemonAddressOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.OMPD_URL;
  if (override !== undefined && override.trim().length > 0) return override.trim().replace(/\/+$/, "");

  const home = options.home ?? env.OMPD_HOME ?? defaultHome();
  const published = readTrimmed(path.join(home, "endpoint"));
  if (published !== null) return published.replace(/\/+$/, "");

  const configPath = path.join(home, "config.json");
  let host = "127.0.0.1";
  let port = DEFAULT_OMPD_PORT;
  const raw = readTrimmed(configPath);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        if ("host" in parsed && typeof parsed.host === "string" && parsed.host.length > 0) host = parsed.host;
        if ("port" in parsed && typeof parsed.port === "number" && Number.isInteger(parsed.port)) port = parsed.port;
      }
    } catch {
      // A corrupt config.json falls back to the compiled default; the daemon's
      // own `loadConfig` is the place that treats this as a hard error at boot.
    }
  }
  return `http://${host}:${port}`;
}

/** `OMPD_TOKEN`, else `<home>/token`, else null when no pairing has happened. */
export function resolveDaemonToken(options: ResolveDaemonAddressOptions = {}): string | null {
  const env = options.env ?? process.env;
  const fromEnv = env.OMPD_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  const home = options.home ?? env.OMPD_HOME ?? defaultHome();
  return readTrimmed(path.join(home, "token"));
}

/** The resolved daemon endpoint and credential a control leg needs as one unit. */
export interface DaemonAddress {
  baseUrl: string;
  token: string | null;
}

/**
 * Resolve the endpoint and credential together so a caller never reaches a
 * daemon using a token read from a different home or environment.
 */
export function resolveDaemonAddress(options: ResolveDaemonAddressOptions = {}): DaemonAddress {
  return {
    baseUrl: resolveDaemonBaseUrl(options),
    token: resolveDaemonToken(options),
  };
}

export const TOKEN_MISSING_GUIDANCE =
  "No ompd device token found.\n" +
  "  Run `ompd start` on this machine: it mints a local operator token at ~/.ompd/token.\n" +
  "  Already running elsewhere? Pair this shell with `ompd pair <name>`, approve the code\n" +
  "  from a device that holds the approve scope, and export OMPD_TOKEN with the result.";

/** `ws://host:port/v1/socket` from a resolved `http(s)://` base URL. */
export function socketUrlFromBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/socket";
  return url.toString();
}

/** `http(s)://host:port/v1/agents` from a resolved base URL. */
export function agentsUrlFromBase(baseUrl: string): string {
  return new URL("/v1/agents", baseUrl).toString();
}
