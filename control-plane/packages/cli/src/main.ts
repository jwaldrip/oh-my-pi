#!/usr/bin/env bun
/**
 * `ompd`.
 *
 * The dispatcher does three things: parse, route, and turn a thrown error into
 * something an operator can act on. Every failure mode a first run actually
 * hits, a missing token above all, arrives here as a typed error and leaves as
 * an instruction. A stack trace tells someone who has just installed this that
 * the tool is broken, when in fact they only need to pair.
 */

import { parseCommand, USAGE, UsageError } from "./args.ts";
import {
  ApiError,
  DaemonUnreachableError,
  defaultContext,
  TokenMissingError,
  type CliContext,
} from "./client.ts";
import { agentsCommand, newCommand, promptCommand, stopAgentCommand } from "./commands/agents.ts";
import { auditCommand } from "./commands/audit.ts";
import {
  configGetCommand,
  configListCommand,
  configSetCommand,
} from "./commands/config.ts";
import { startCommand, statusCommand } from "./commands/daemon.ts";
import {
  approveCommand,
  devicesCommand,
  inviteCommand,
  pairCommand,
  revokeCommand,
  rotateCommand,
} from "./commands/devices.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { openCommand } from "./commands/open.ts";
import { routinesCommand, runCommand, webhookSecretCommand } from "./commands/routines.ts";
import { installCommand, uninstallCommand } from "./commands/service.ts";
import { selfInstallCommand } from "./commands/self-install.ts";
import { OMPD_VERSION } from "@ompd/daemon";

export async function run(argv: string[], ctx: CliContext = defaultContext()): Promise<number> {
  try {
    const command = parseCommand(argv);

    switch (command.kind) {
      case "help":
        ctx.out(USAGE);
        return 0;
      case "version":
        ctx.out(OMPD_VERSION);
        return 0;
      case "start":
        return await startCommand(ctx, command);
      case "status":
        return await statusCommand(ctx);
      case "config":
        switch (command.action) {
          case "list":
            return await configListCommand(ctx);
          case "get":
            return await configGetCommand(ctx, command);
          case "set":
            return await configSetCommand(ctx, command);
          default: {
            // A variant added later must break the build here rather than fall
            // through into no response at all. The narrowed value itself is
            // what gets assigned: reading `.action` off it cannot compile,
            // because an exhaustive switch has already narrowed it to `never`.
            const exhaustive: never = command;
            throw new Error(`unhandled config action ${JSON.stringify(exhaustive)}`);
          }
        }
      case "pair":
        return await pairCommand(ctx, command);
      case "approve":
        return await approveCommand(ctx, command);
      case "invite":
        return await inviteCommand(ctx, command);
      case "devices":
        return await devicesCommand(ctx);
      case "revoke":
        return await revokeCommand(ctx, command);
      case "rotate":
        return await rotateCommand(ctx, command);
      case "agents":
        return await agentsCommand(ctx);
      case "new":
        return await newCommand(ctx, command);
      case "stop-agent":
        return await stopAgentCommand(ctx, command);
      case "prompt":
        return await promptCommand(ctx, command);
      case "routines":
        return await routinesCommand(ctx);
      case "run":
        return await runCommand(ctx, command);
      case "webhook-secret":
        return await webhookSecretCommand(ctx, command);
      case "audit":
        return await auditCommand(ctx, command);
      case "open":
        return await openCommand(ctx);
      case "self-install":
        return await selfInstallCommand(ctx, command);
      case "doctor":
        return await doctorCommand(ctx);
      case "install":
        return await installCommand(ctx, command);
      default:
        return await uninstallCommand(ctx);
    }
  } catch (err) {
    return report(ctx, err);
  }
}

/** Every error the CLI can produce, as advice rather than as a trace. */
function report(ctx: CliContext, err: unknown): number {
  if (err instanceof UsageError) {
    ctx.err(`ompd: ${err.message}`);
    ctx.err("");
    ctx.err(USAGE);
    return 2;
  }

  if (err instanceof TokenMissingError) {
    ctx.err(err.message);
    return 1;
  }

  if (err instanceof DaemonUnreachableError) {
    ctx.err(`ompd: ${err.message}`);
    ctx.err("  start it with `ompd start`, or set OMPD_URL if it listens elsewhere");
    return 1;
  }

  if (err instanceof ApiError) {
    ctx.err(`ompd: ${err.message}`);
    return 1;
  }

  ctx.err(`ompd: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
}

// `import.meta.main` is false when a test imports this module, so importing
// `run` never runs a command.
if (import.meta.main) process.exit(await run(process.argv.slice(2)));
