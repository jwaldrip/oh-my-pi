/**
 * Routines: what is scheduled, and running one now.
 *
 * `run` is a manual fire, not a reschedule. The routine's own timer is
 * untouched, which is what makes it safe to use for a smoke test of something
 * that normally runs nightly.
 */

import type { Routine, Run, TriggerSpec } from "@ompd/core";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { table } from "../format.ts";

interface RoutinesResponse {
  routines?: Routine[];
}

interface RunResponse {
  run?: Run;
}

interface WebhookSecretResponse {
  secret?: unknown;
}

function describeTrigger(trigger: TriggerSpec): string {
  switch (trigger.kind) {
    case "cron":
      return `cron ${trigger.expression}${trigger.timezone === undefined ? "" : ` ${trigger.timezone}`}`;
    case "interval":
      return `every ${trigger.seconds}s`;
    case "webhook":
      return `webhook ${trigger.secretRef}`;
    default:
      return "manual";
  }
}

export async function routinesCommand(ctx: CliContext): Promise<number> {
  const response = await api<RoutinesResponse>(ctx, "/v1/routines");
  const routines = response.routines ?? [];
  if (routines.length === 0) {
    ctx.out("no routines");
    return 0;
  }

  const rows = routines.map((routine) => [
    routine.id,
    routine.enabled ? "enabled" : "disabled",
    routine.name,
    describeTrigger(routine.trigger),
    routine.cwd,
  ]);
  for (const line of table(["ID", "STATE", "NAME", "TRIGGER", "CWD"], rows)) ctx.out(line);
  return 0;
}

export async function runCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "run" }>,
): Promise<number> {
  const response = await api<RunResponse>(ctx, `/v1/routines/${encodeURIComponent(cmd.routineId)}/run`, {
    method: "POST",
  });

  const run = response.run;
  if (run === undefined) {
    ctx.err("the daemon started no run");
    return 1;
  }

  ctx.out(`${run.id}  ${run.state}`);
  if (run.agentId !== undefined) ctx.out(`  agent   ${run.agentId}`);
  if (run.summary !== undefined) ctx.out(`  summary ${run.summary}`);
  if (run.error !== undefined) ctx.out(`  error   ${run.error}`);
  // A failed run is a failed command. Exiting 0 here would make this useless
  // in anything that checks a status code.
  return run.state === "failed" || run.state === "timed_out" ? 1 : 0;
}

/**
 * Rotate the per-routine credential and print the replacement exactly once.
 * The daemon retains only a hash, so this is the sole chance to copy it.
 */
export async function webhookSecretCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "webhook-secret" }>,
): Promise<number> {
  const response = await api<WebhookSecretResponse>(
    ctx,
    `/v1/routines/${encodeURIComponent(cmd.routineId)}/webhook-secret`,
    { method: "POST" },
  );
  if (typeof response.secret !== "string") {
    ctx.err("the daemon minted no webhook secret");
    return 1;
  }

  ctx.out(`webhook secret for ${cmd.routineId}`);
  ctx.out("");
  ctx.out(`  ${response.secret}`);
  ctx.out("");
  ctx.out("  This secret is shown once and is not recoverable. The daemon keeps only its");
  ctx.out("  hash. Copy it now; mint another one if you lose it.");
  return 0;
}
