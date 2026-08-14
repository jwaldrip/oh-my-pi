/**
 * Correlating what an agent did against what ompd's policy engine was asked.
 *
 * This exists as its own module, rather than inline in a check, because it is
 * the part of a live probe that can silently lie in both directions. A checker
 * that cannot pair a mutation with its approval row reports a closed gate as
 * open, which is what happened before: `reportGate` joined gate-2 approval ids
 * against ACP `toolCallId`s and matched nothing at all, so every call in every
 * run read as NEVER ASKED and only the mutating ones escalated to a failure.
 *
 * ## Why an identity join is impossible, not merely broken
 *
 * OMP has two approval channels. `session/request_permission` carries the
 * `toolCallId`. `elicitation/create`, the only channel a content-only `edit` or
 * a `write` reaches, does not: its request carries `sessionId`, `message`,
 * `enumValues`, and `requestedSchema` and nothing that names the call. The
 * daemon therefore mints its own `elc_<hex>` id for that row. Joining `elc_*`
 * against `toolu_*` compares disjoint namespaces.
 *
 * Making the identity join work would mean having the daemon guess the pairing
 * by matching parsed paths against recent tool calls in the same session, which
 * puts a heuristic inside a security decision. Giving each gate its own honest
 * id is the better trade, so the correlation belongs here, in the probe, where a
 * wrong guess fails a test instead of allowing a write.
 *
 * ## What this joins on instead
 *
 * The subject of the call: the path it writes, or the command it runs. Both
 * sides record it, and in a probe the two are byte-identical because the harness
 * created the path itself. The asymmetry that makes this safe: a false pass
 * requires an approval row that names the very path that was mutated, and such a
 * row existing is the property being asserted. The failure mode is a false
 * alarm, not a missed one.
 *
 * The ACP `kind` and the policy `tool` do not agree by name either (`edit`
 * against `write`), which is a second reason not to join on names.
 */

/** ACP tool kinds that reach the filesystem or the shell. */
export const MUTATING_KINDS: Record<string, true> = {
  edit: true,
  execute: true,
  delete: true,
  move: true,
};

export interface CallSubject {
  id: string;
  kind: string;
  title: string;
  /** Absolute paths the call names, parsed from its raw input. */
  paths: string[];
  /** The shell command, for an `execute`. */
  command: string | null;
}

/** The shape this needs from a stored approval, so a test need not build a Store. */
export interface ApprovalSubject {
  requestId: string;
  tool: string;
  input: unknown;
  decision: string;
  rule: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Every path and command named by a payload, from either side of the join.
 *
 * Deliberately generous about field names: the tool call carries `path`, the
 * approval carries `paths`, and a probe that missed one because a key was spelled
 * differently would report a gate hole that does not exist.
 */
export function subjectsOf(payload: unknown): { paths: string[]; command: string | null } {
  const record = asRecord(payload);
  if (record === null) return { paths: [], command: null };

  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath", "target", "dest"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  for (const key of ["paths", "files"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) paths.push(entry);
    }
  }

  const rawCommand = record.command;
  const command = typeof rawCommand === "string" && rawCommand.length > 0 ? rawCommand : null;
  return { paths: [...new Set(paths)], command };
}

/**
 * The approval rows that account for a call, empty when nothing does.
 *
 * A row accounts for a call when they name a path in common, or when both name
 * the same command. Returning the rows rather than a boolean lets a caller print
 * the rule that decided it, which is the difference between "something was
 * asked" and "the right thing was asked".
 */
export function coverFor(call: CallSubject, approvals: readonly ApprovalSubject[]): ApprovalSubject[] {
  const wanted = new Set(call.paths);
  return approvals.filter((approval) => {
    const subject = subjectsOf(approval.input);
    if (subject.paths.some((path) => wanted.has(path))) return true;
    return call.command !== null && subject.command === call.command;
  });
}

/**
 * Mutating calls that no approval row accounts for.
 *
 * The caller treats a non-empty result as a failure. A mutating call carrying
 * neither a path nor a command is included: an unidentifiable mutation cannot be
 * shown to have been gated, and in a security probe that is a failure rather
 * than something to wave through.
 */
export function uncoveredMutations(
  calls: readonly CallSubject[],
  approvals: readonly ApprovalSubject[],
): CallSubject[] {
  const uncovered: CallSubject[] = [];
  for (const call of calls) {
    if (MUTATING_KINDS[call.kind] !== true) continue;
    if (call.paths.length === 0 && call.command === null) {
      uncovered.push(call);
      continue;
    }
    if (coverFor(call, approvals).length === 0) uncovered.push(call);
  }
  return uncovered;
}
