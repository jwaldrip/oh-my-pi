/**
 * Opens a portable `.ompsession` boundary without treating it as a credential.
 *
 * Native shells provide an opened document at app launch. This module validates
 * that document, resolves its optional daemon hint only against a pairing the
 * device already owns, and asks the existing console attach path to show the
 * live agent holding the named OMP session. The markdown is handed to the UI
 * as display data only; opening a file never turns its contents into a prompt.
 */

import type { AgentId, SessionSummary } from "@ompd/core/contracts";
import { OmpSessionFormatError, parseOmpSession, type OmpSessionContainer } from "@ompd/core/handoff-container";
import type { Connection } from "./connection.ts";

export interface OpenedDocument {
  /** A filesystem path or file URL supplied by the native shell. */
  name: string;
  /** The native document bridge has already read this short JSON container. */
  text: string;
}

export interface OmpSessionBootDependencies {
  /** Reads the one document that caused this launch, if any. */
  readInitialDocument: () => Promise<OpenedDocument | null>;
  /** Loads the durable pairing. The file itself never provides credentials. */
  loadConnection: () => Promise<Connection | null>;
  /** Reads the daemon's authoritative session catalog through that pairing. */
  listSessions: (connection: Connection) => Promise<readonly SessionSummary[]>;
  /** `useConsole(...).actions.select`: selects and attaches the live agent. */
  selectAgent: (agentId: AgentId) => void;
  /** Gives the UI the human-readable boundary to display, never execute. */
  onHandoff?: (handoff: OmpSessionContainer) => void;
}

export type OmpSessionBootResult =
  | { status: "no-document" }
  | { status: "ignored" }
  | { status: "invalid" }
  | { status: "pairing-required"; daemonHint?: string }
  | { status: "daemon-mismatch"; daemonHint: string }
  | { status: "session-unavailable"; sessionId: string }
  | { status: "resumed"; sessionId: string };

/**
 * Handle the document that launched the app.
 *
 * A handoff can only attach an already-live `live-ompd` session. The session
 * index maps its durable `SessionSummary.id` to the transient agent id required
 * by `OmpdClient.attach`; a dormant or TUI-owned session is deliberately not
 * guessed or claimed through a second resume path.
 */
export async function bootOpenedOmpSession(deps: OmpSessionBootDependencies): Promise<OmpSessionBootResult> {
  const document = await deps.readInitialDocument();
  if (document === null) return { status: "no-document" };
  if (!isOmpSessionDocument(document.name)) return { status: "ignored" };

  let handoff: OmpSessionContainer;
  try {
    handoff = parseOmpSession(document.text);
  } catch (error) {
    if (error instanceof OmpSessionFormatError) return { status: "invalid" };
    throw error;
  }

  const connection = await deps.loadConnection();
  if (connection === null) {
    return handoff.daemonHint === undefined
      ? { status: "pairing-required" }
      : { status: "pairing-required", daemonHint: handoff.daemonHint };
  }
  const daemonMatches =
    connection.transport === "direct"
      ? connection.url === handoff.daemonHint
      : connection.hubUrl === handoff.daemonHint || connection.daemonId === handoff.daemonHint;
  if (handoff.daemonHint !== undefined && !daemonMatches) {
    return { status: "daemon-mismatch", daemonHint: handoff.daemonHint };
  }

  const session = (await deps.listSessions(connection)).find((candidate) => candidate.id === handoff.sessionId);
  if (session?.status !== "live-ompd" || session.agentId === undefined) {
    return { status: "session-unavailable", sessionId: handoff.sessionId };
  }

  deps.onHandoff?.(handoff);
  deps.selectAgent(session.agentId);
  return { status: "resumed", sessionId: handoff.sessionId };
}

/** Whether a native shell's file path or file URL identifies an `.ompsession` document. */
export function isOmpSessionDocument(name: string): boolean {
  const path = pathFromDocumentName(name);
  return path.toLocaleLowerCase().endsWith(".ompsession");
}


function pathFromDocumentName(name: string): string {
  try {
    return new URL(name).pathname;
  } catch {
    return name.split(/[?#]/, 1)[0] ?? name;
  }
}
