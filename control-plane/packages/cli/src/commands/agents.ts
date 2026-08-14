/**
 * Agent listing and lifecycle.
 *
 * An agent outlives the command that made it. `new` returns as soon as the
 * daemon has a session, and stopping one is an explicit act rather than
 * something that happens when a terminal closes.
 */

import { basename, resolve } from "node:path";
import type { Agent, HostSpec } from "@ompd/core";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { age, table } from "../format.ts";

interface AgentsResponse {
  agents?: Agent[];
}

interface CreateAgentResponse {
  agent?: Agent;
}

interface PromptResponse {
  stopReason?: string;
}

export async function agentsCommand(ctx: CliContext): Promise<number> {
  const response = await api<AgentsResponse>(ctx, "/v1/agents");
  const agents = response.agents ?? [];
  if (agents.length === 0) {
    ctx.out("no agents");
    return 0;
  }

  const rows = agents.map((agent) => [
    agent.id,
    agent.state,
    agent.name,
    agent.cwd,
    age(agent.lastActiveAt),
  ]);
  for (const line of table(["ID", "STATE", "NAME", "CWD", "ACTIVE"], rows)) ctx.out(line);
  return 0;
}

export async function newCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "new" }>,
): Promise<number> {
  // Resolved here, against the shell's cwd. A relative path means nothing to a
  // daemon that may have been started from anywhere, or by launchd from `/`.
  const cwd = resolve(ctx.cwd, cmd.cwd);
  const host: HostSpec | undefined = cmd.container
    ? { kind: "container", image: cmd.image, mounts: cmd.mounts }
    : undefined;
  const response = await api<CreateAgentResponse>(ctx, "/v1/agents", {
    method: "POST",
    body: { name: cmd.name ?? basename(cwd), cwd, host },
  });

  const agent = response.agent;
  if (agent === undefined) {
    ctx.err("the daemon created no agent");
    return 1;
  }

  ctx.out(`${agent.id}  ${agent.state}  ${agent.name}`);
  ctx.out(`  cwd     ${agent.cwd}`);
  ctx.out(`  host    ${agent.host.kind} ${agent.host.id}`);
  // The effective mount set, not merely what was typed: the daemon fills in
  // the default mode, and this is the one place an operator can see what a
  // sandbox they just created can actually reach.
  const mounts = agent.host.spec.mounts ?? [];
  if (mounts.length > 0) {
    ctx.out("  mounts:");
    for (const mount of mounts) ctx.out(`    ${mount.hostPath} (${mount.mode ?? "ro"})`);
  }
  return 0;
}

export async function stopAgentCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "stop-agent" }>,
): Promise<number> {
  await api(ctx, `/v1/agents/${encodeURIComponent(cmd.agentId)}`, { method: "DELETE" });
  ctx.out(`stopped ${cmd.agentId}`);
  return 0;
}

/**
 * Send one prompt and wait for the turn to settle.
 *
 * Prints the stop reason and nothing else. The transcript streams over the
 * websocket, which a script driving this does not have and does not want; what
 * it needs is to know the turn is over and how it ended.
 */
export async function promptCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "prompt" }>,
): Promise<number> {
  const response = await api<PromptResponse>(
    ctx,
    `/v1/agents/${encodeURIComponent(cmd.agentId)}/prompt`,
    { method: "POST", body: { text: cmd.text } },
  );
  ctx.out(response.stopReason ?? "unknown");
  return 0;
}
