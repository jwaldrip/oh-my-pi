/**
 * The audit log.
 *
 * Every privileged action lands here with its actor and outcome, which makes
 * this the command that answers "what did it do, and who asked".
 */

import type { AuditEntry } from "@ompd/core";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { age, table } from "../format.ts";

interface AuditResponse {
  entries?: AuditEntry[];
}

export async function auditCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "audit" }>,
): Promise<number> {
  const response = await api<AuditResponse>(ctx, `/v1/audit?limit=${cmd.limit}`);
  const entries = response.entries ?? [];
  if (entries.length === 0) {
    ctx.out("no audit entries");
    return 0;
  }

  const rows = entries.map((entry) => [
    age(entry.ts),
    entry.action,
    entry.outcome,
    entry.actorDeviceId ?? "-",
    entry.agentId ?? "-",
  ]);
  for (const line of table(["WHEN", "ACTION", "OUTCOME", "ACTOR", "AGENT"], rows)) ctx.out(line);
  return 0;
}
