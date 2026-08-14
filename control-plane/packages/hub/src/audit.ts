/**
 * What the hub writes down.
 *
 * Structured JSON on stdout, because on Cloud Run that *is* the durable sink:
 * the platform ships stdout to Cloud Logging, which outlives the instance. A
 * file would not, and a database would be a second thing to run for a stream
 * nobody queries interactively.
 *
 * Every refusal is recorded, and each one names which door closed. "Refused"
 * on its own cannot tell an unenrolled daemon from a client whose token was
 * withdrawn, and those call for opposite responses from an operator.
 *
 * Nothing sensitive can be recorded here because nothing sensitive reaches
 * this process: the hub never holds a bearer token, and payloads are sealed
 * before they arrive. `payload` is therefore never a field, deliberately, so
 * that no later edit can quietly start logging ciphertext or anything else.
 */

import type { RefusalCode } from "@ompd/tunnel";

export type HubAuditAction =
  | "daemon.register"
  | "daemon.disconnect"
  | "client.link"
  | "client.disconnect"
  | "session.torn"
  | "enroll.create"
  | "enroll.remove";

export interface HubAuditEntry {
  readonly ts: string;
  readonly action: HubAuditAction;
  readonly outcome: "ok" | "denied" | "error";
  readonly instanceId: string;
  readonly daemonId?: string;
  readonly sessionId?: string;
  readonly code?: RefusalCode | "done";
  readonly detail?: Record<string, string | number | boolean>;
}

export type HubAudit = (entry: HubAuditEntry) => void;

/** The default sink. One line, one event, parseable by the platform. */
export function consoleAudit(entry: HubAuditEntry): void {
  // `severity` is the field Cloud Logging promotes out of a JSON line, so a
  // denial is filterable without parsing the message.
  const severity = entry.outcome === "ok" ? "INFO" : entry.outcome === "denied" ? "WARNING" : "ERROR";
  process.stdout.write(`${JSON.stringify({ severity, ...entry })}\n`);
}

/** Collects entries instead of writing them. For tests and for `GET /v1/audit`. */
export class RecordingAudit {
  readonly entries: HubAuditEntry[] = [];

  readonly record: HubAudit = (entry) => {
    this.entries.push(entry);
  };

  /** Entries matching an action, in order. */
  forAction(action: HubAuditAction): HubAuditEntry[] {
    return this.entries.filter((entry) => entry.action === action);
  }
}
