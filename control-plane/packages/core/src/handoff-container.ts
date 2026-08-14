/**
 * The portable boundary of an OMP session handoff.
 *
 * A `.ompsession` file is intentionally a small JSON document. It identifies
 * the session to attach to and carries the operator-readable boundary that
 * explains where the preceding client left off. It never carries a bearer
 * token: the receiving device must use a pairing it already holds.
 */

export const OMP_SESSION_VERSION = "1.0" as const;

export interface OmpSessionContainer {
  version: typeof OMP_SESSION_VERSION;
  sessionId: string;
  handoffMarkdown: string;
  activeModel: string;
  daemonHint?: string;
}

export class OmpSessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpSessionFormatError";
  }
}

/** Serialize a validated handoff into the portable `.ompsession` boundary. */
export function serializeOmpSession(container: OmpSessionContainer): string {
  const parsed = validate(container);
  return JSON.stringify({
    version: parsed.version,
    sessionId: parsed.sessionId,
    handoffMarkdown: parsed.handoffMarkdown,
    activeModel: parsed.activeModel,
    ...(parsed.daemonHint === undefined ? {} : { daemonHint: parsed.daemonHint }),
  });
}

/** Parse a `.ompsession` file and reject versions or field shapes this client cannot safely understand. */
export function parseOmpSession(serialized: string): OmpSessionContainer {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new OmpSessionFormatError(".ompsession must be valid JSON");
  }
  return validate(value);
}

function validate(value: unknown): OmpSessionContainer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OmpSessionFormatError(".ompsession must contain an object");
  }

  const record = value as Record<string, unknown>;
  if (record.version !== OMP_SESSION_VERSION) {
    throw new OmpSessionFormatError(`unsupported .ompsession version: ${String(record.version)}`);
  }

  const sessionId = requiredString(record, "sessionId");
  const handoffMarkdown = requiredString(record, "handoffMarkdown", { allowEmpty: true });
  const activeModel = requiredString(record, "activeModel");
  const daemonHint = optionalString(record, "daemonHint");

  return {
    version: OMP_SESSION_VERSION,
    sessionId,
    handoffMarkdown,
    activeModel,
    ...(daemonHint === undefined ? {} : { daemonHint }),
  };
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new OmpSessionFormatError(`.ompsession ${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new OmpSessionFormatError(`.ompsession ${field} must be a non-empty string when provided`);
  }
  return value;
}
