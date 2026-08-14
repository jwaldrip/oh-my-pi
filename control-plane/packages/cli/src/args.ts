/**
 * Argv to a command object, and nothing else.
 *
 * Parsing is separated from doing so that every accepted and rejected spelling
 * can be asserted without a daemon, a socket, or a filesystem. No framework:
 * the grammar is a verb, some positionals, and a handful of flags, and a
 * dependency that turns that into configuration would be larger than the thing
 * it configures.
 */

import { SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, type HostMount } from "@ompd/core";

/** Raised for anything the user could fix by retyping the line. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const KNOWN_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE];

/** Flags that take no value; anything else consumes the next token. */
const BOOLEAN_FLAGS: Record<string, true> = {
  foreground: true,
  help: true,
  version: true,
  "allow-source-path": true,
  container: true,
};

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start"; host?: string; port?: number; foreground: boolean }
  | { kind: "status" }
  | { kind: "config"; action: "list" }
  | { kind: "config"; action: "get"; key: string }
  | { kind: "config"; action: "set"; key: string; value: string }
  | { kind: "pair"; name: string; scopes: string[] }
  | { kind: "approve"; code: string; scopes: string[] }
  | { kind: "devices" }
  | { kind: "revoke"; deviceId: string }
  | { kind: "rotate"; deviceId?: string }
  | { kind: "agents" }
  | {
      kind: "new";
      cwd: string;
      name?: string;
      container: boolean;
      image?: string;
      mounts?: HostMount[];
    }
  | { kind: "stop-agent"; agentId: string }
  | { kind: "prompt"; agentId: string; text: string }
  | { kind: "routines" }
  | { kind: "run"; routineId: string }
  | { kind: "webhook-secret"; routineId: string }
  | { kind: "audit"; limit: number }
  | { kind: "open" }
  | { kind: "self-install"; prefix?: string }
  | { kind: "doctor" }
  | { kind: "install"; prefix?: string; allowSourcePath: boolean }
  | { kind: "uninstall" };

export const USAGE = `ompd - control plane for OMP agents

usage: ompd <command> [options]

setup
  self-install [--prefix D]
                          compile ompd and install it, default ~/.local/bin
  doctor                  check the install, the daemon, and this machine
  install [--prefix D] [--allow-source-path]
                          install and load the launchd agent
  uninstall               unload and remove the launchd agent

daemon
  start [--host H] [--port N] [--foreground]
                          run the daemon
  status                  is it running, what is it doing

config
  config                  print effective configuration, defaults merged with the file
  config get <key>        print one effective value
  config set <key> <value>
                          persist a value to <home>/config.json; validated the same way
                          the daemon validates it at its own startup

devices
  pair <name> [--scopes read,prompt]
                          begin pairing and print the code to approve
  approve <code> --scopes read,prompt,manage,approve
                          approve a pending pairing and print its token once
  devices                 list paired devices
  revoke <deviceId>       revoke a device
  rotate [--device <id>]  replace a token; the old one stops working

agents
  agents                  list agents
  new <cwd> [--name N] [--container [--image I] [--mounts P[:ro|rw],...]]
                          create an agent; --mounts only with --container
  stop-agent <id>         stop an agent
  prompt <id> <text>      send a prompt and wait for the turn to settle

routines
  routines                list routines
  run <routineId>         run a routine now
  routines webhook-secret <routineId>
                          replace a webhook secret and print the new value once

audit
  audit [--limit N]       recent privileged actions

scopes: ${KNOWN_SCOPES.join(", ")}

The daemon binds loopback by default; change it with config set host <address> before
starting, or make it reachable from elsewhere with config set hubUrl wss://host. OMPD_URL
overrides where the CLI looks for it and OMPD_TOKEN overrides the token in ~/.ompd/token.`;

interface ParsedTokens {
  positional: string[];
  flags: Map<string, string | true>;
}

function splitTokens(argv: string[]): ParsedTokens {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (body.length === 0) {
      // A bare `--` would conventionally end flag parsing. Nothing here takes
      // a trailing free-form argument, so accepting it would only hide a typo.
      throw new UsageError("`--` on its own is not a flag");
    }

    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS[body] === true) {
      flags.set(body, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${body} needs a value`);
    }
    flags.set(body, value);
    i += 1;
  }

  return { positional, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} must be an integer, got ${raw}`);
  return value;
}

/**
 * `read,prompt` to a validated, deduplicated scope list.
 *
 * Unknown scopes are rejected rather than dropped. A typo that silently
 * granted less than the operator asked for produces a device that fails later,
 * somewhere unrelated, for a reason nobody will connect to this line.
 */
export function parseScopes(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new UsageError("--scopes was empty");

  const unknown = parts.filter((part) => !KNOWN_SCOPES.includes(part));
  if (unknown.length > 0) {
    throw new UsageError(`unknown scope ${unknown.join(", ")}; known scopes are ${KNOWN_SCOPES.join(", ")}`);
  }
  return [...new Set(parts)];
}

/**
 * `/data:ro,/tools:rw` to a validated mount list. A bare path with no suffix
 * defaults to read-only downstream; the mode is only ever written here when
 * the operator actually typed one, so "default" stays one decision in one
 * place rather than two that could drift apart.
 */
export function parseMounts(raw: string): HostMount[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new UsageError("--mounts was empty");

  return parts.map((part) => {
    const match = /^(.+):(ro|rw)$/.exec(part);
    if (match !== null) return { hostPath: match[1] as string, mode: match[2] as "ro" | "rw" };
    if (part.includes(":")) {
      throw new UsageError(`--mounts entry ${JSON.stringify(part)} has an unknown mode; use :ro or :rw`);
    }
    return { hostPath: part };
  });
}

function requirePositional(positional: string[], index: number, label: string): string {
  const value = positional[index];
  if (value === undefined) throw new UsageError(`missing <${label}>`);
  return value;
}

function rejectExtra(positional: string[], allowed: number, verb: string): void {
  if (positional.length > allowed) {
    throw new UsageError(`${verb} takes ${allowed} argument${allowed === 1 ? "" : "s"}`);
  }
}

export function parseCommand(argv: string[]): Command {
  const { positional, flags } = splitTokens(argv);
  const verb = positional[0];

  // `--version` before the bare-invocation fallback. Both are flags with no
  // verb beside them, so checking "no verb means help" first would answer
  // `ompd --version` with the usage text, which is what every installer, every
  // package manager, and `ompd doctor` all read to learn the version.
  if (flags.get("version") === true || verb === "version") return { kind: "version" };
  if (flags.get("help") === true || verb === undefined || verb === "help") return { kind: "help" };

  const rest = positional.slice(1);

  switch (verb) {
    case "start": {
      rejectExtra(rest, 0, "start");
      const port = numberFlag(flags, "port");
      if (port !== undefined && (port < 0 || port > 65_535)) {
        throw new UsageError(`--port must be between 0 and 65535, got ${port}`);
      }
      return {
        kind: "start",
        host: stringFlag(flags, "host"),
        port,
        foreground: flags.get("foreground") === true,
      };
    }

    case "status":
      rejectExtra(rest, 0, "status");
      return { kind: "status" };

    case "config": {
      const sub = rest[0];
      if (sub === undefined) {
        rejectExtra(rest, 0, "config");
        return { kind: "config", action: "list" };
      }
      if (sub === "get") {
        const configArgs = rest.slice(1);
        rejectExtra(configArgs, 1, "config get");
        return { kind: "config", action: "get", key: requirePositional(configArgs, 0, "key") };
      }
      if (sub === "set") {
        const configArgs = rest.slice(1);
        rejectExtra(configArgs, 2, "config set");
        return {
          kind: "config",
          action: "set",
          key: requirePositional(configArgs, 0, "key"),
          value: requirePositional(configArgs, 1, "value"),
        };
      }
      throw new UsageError(
        `unknown config action ${sub}; use config, config get <key>, or config set <key> <value>`,
      );
    }

    case "pair": {
      rejectExtra(rest, 1, "pair");
      const scopes = stringFlag(flags, "scopes");
      return {
        kind: "pair",
        name: requirePositional(rest, 0, "name"),
        // Only used to print the approve line the operator runs next. Nothing
        // a pairing client asks for reaches the device row, which is the
        // property that keeps pairing from being a self-service grant.
        scopes: scopes === undefined ? [SCOPE_READ, SCOPE_PROMPT] : parseScopes(scopes),
      };
    }

    case "approve": {
      rejectExtra(rest, 1, "approve");
      const code = requirePositional(rest, 0, "code");
      const scopes = stringFlag(flags, "scopes");
      // Required, unlike on `pair`. This is the line that actually grants
      // authority, and a default grant is one nobody chose.
      if (scopes === undefined) throw new UsageError("approve needs --scopes");
      return { kind: "approve", code, scopes: parseScopes(scopes) };
    }

    case "devices":
      rejectExtra(rest, 0, "devices");
      return { kind: "devices" };

    case "revoke":
      rejectExtra(rest, 1, "revoke");
      return { kind: "revoke", deviceId: requirePositional(rest, 0, "deviceId") };

    case "rotate": {
      rejectExtra(rest, 0, "rotate");
      // A flag rather than a positional, so the bare form is unambiguously
      // "rotate the credential I am holding" and cannot be a mistyped device
      // id that silently rotates the wrong one.
      const deviceId = stringFlag(flags, "device");
      return deviceId === undefined ? { kind: "rotate" } : { kind: "rotate", deviceId };
    }

    case "agents":
      rejectExtra(rest, 0, "agents");
      return { kind: "agents" };

    case "new": {
      rejectExtra(rest, 1, "new");
      const container = flags.get("container") === true;
      const image = stringFlag(flags, "image");
      const mountsRaw = stringFlag(flags, "mounts");
      if (!container && image !== undefined) throw new UsageError("--image needs --container");
      if (!container && mountsRaw !== undefined) throw new UsageError("--mounts needs --container");
      return {
        kind: "new",
        cwd: requirePositional(rest, 0, "cwd"),
        name: stringFlag(flags, "name"),
        container,
        image,
        mounts: mountsRaw === undefined ? undefined : parseMounts(mountsRaw),
      };
    }

    case "stop-agent":
      rejectExtra(rest, 1, "stop-agent");
      return { kind: "stop-agent", agentId: requirePositional(rest, 0, "id") };

    case "prompt": {
      const agentId = requirePositional(rest, 0, "agentId");
      // Joined rather than capped at one positional, so an unquoted prompt is
      // sent as written instead of rejected for having spaces in it.
      const text = rest.slice(1).join(" ");
      if (text.length === 0) throw new UsageError("prompt needs text to send");
      return { kind: "prompt", agentId, text };
    }

    case "routines": {
      const action = rest[0];
      if (action === undefined) return { kind: "routines" };
      if (action !== "webhook-secret") {
        throw new UsageError(`unknown routines action ${action}; use routines or routines webhook-secret <routineId>`);
      }
      const args = rest.slice(1);
      rejectExtra(args, 1, "routines webhook-secret");
      return { kind: "webhook-secret", routineId: requirePositional(args, 0, "routineId") };
    }

    case "run":
      rejectExtra(rest, 1, "run");
      return { kind: "run", routineId: requirePositional(rest, 0, "routineId") };

    case "audit": {
      rejectExtra(rest, 0, "audit");
      const limit = numberFlag(flags, "limit") ?? 50;
      if (limit <= 0) throw new UsageError(`--limit must be positive, got ${limit}`);
      return { kind: "audit", limit };
    }

    case "open":
      rejectExtra(rest, 0, "open");
      return { kind: "open" };

    case "self-install": {
      rejectExtra(rest, 0, "self-install");
      const prefix = stringFlag(flags, "prefix");
      return prefix === undefined ? { kind: "self-install" } : { kind: "self-install", prefix };
    }

    case "doctor":
      rejectExtra(rest, 0, "doctor");
      return { kind: "doctor" };

    case "install": {
      rejectExtra(rest, 0, "install");
      const prefix = stringFlag(flags, "prefix");
      // Opt-in rather than a prompt, because the thing being allowed is a
      // launch agent that quietly stops working when a directory is removed,
      // and nobody should be able to agree to that by pressing return.
      const allowSourcePath = flags.get("allow-source-path") === true;
      return prefix === undefined
        ? { kind: "install", allowSourcePath }
        : { kind: "install", prefix, allowSourcePath };
    }

    case "uninstall":
      rejectExtra(rest, 0, "uninstall");
      return { kind: "uninstall" };

    default:
      throw new UsageError(`unknown command ${verb}`);
  }
}
