/**
 * Operator-initiated import of non-secret configuration from another daemon.
 *
 * The supplied credential is used only for the target export. The local
 * import goes through `api`, which presents this daemon's own credential.
 */
import { ApiError, api, type CliContext } from "../client.ts";
import type { Command } from "../args.ts";

export async function syncConfigCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "sync-config" }>,
): Promise<number> {
  let target: URL;
  try {
    target = new URL(cmd.targetUrl);
  } catch {
    throw new Error(`invalid target URL ${cmd.targetUrl}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`target URL must use http or https, got ${target.protocol}`);
  }
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/v1/sync/export`;
  target.search = "";
  target.hash = "";

  const exported = await ctx.fetch(target.toString(), {
    headers: { authorization: `Bearer ${cmd.token}` },
  });
  if (!exported.ok) {
    const body = await exported.text();
    throw new ApiError(exported.status, `target sync export failed: ${body || exported.statusText}`);
  }
  const document: unknown = await exported.json();
  const result = await api<{ routines?: unknown }>(ctx, "/v1/sync/import", {
    method: "POST",
    body: document,
  });
  ctx.out(`imported ${typeof result.routines === "number" ? result.routines : "configuration"} routine definitions`);
  return 0;
}
