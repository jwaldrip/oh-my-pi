/**
 * The tunnel wire contract.
 *
 * Three layers travel this path and keeping them straight is what makes the
 * hub content-blind:
 *
 *   1. The hub envelope (this file). Routing only. The hub reads it.
 *   2. The sealed payload (`channel.ts`). AES-256-GCM between client and
 *      daemon. The hub carries it and cannot open it.
 *   3. The `ClientFrame`/`ServerFrame` pair the gateway already speaks, which
 *      travels inside layer 2 unchanged.
 *
 * Layer 3 being untouched is deliberate. `attach { sinceSeq }` replay works
 * through the tunnel precisely because the tunnel does not know what an attach
 * is, so there is no second place for replay to be got wrong.
 */

export const PROTOCOL_VERSION = 1;

/** Opaque to the hub, and to everything in this file. Base64url ciphertext. */
export type SealedPayload = string;

export type SessionId = string;

/**
 * Session ids are minted by the hub, which is the party this protocol does not
 * trust, and they are bound into the handshake transcript. Constraining the
 * alphabet keeps a hostile id from carrying anything but an identifier.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Why a leg was refused or torn down.
 *
 * Each is a closed door rather than a retry hint, and they are kept apart so an
 * audit line can say which door: "refused" alone cannot tell an unenrolled
 * daemon from a revoked device, and those call for opposite responses from an
 * operator.
 */
export type RefusalCode =
  | "bad_request"
  | "unknown_daemon"
  | "daemon_offline"
  | "unverifiable"
  | "unknown_client"
  | "revoked"
  | "version_mismatch"
  | "relay_broken"
  | "rate_limited";

// ---------------------------------------------------------------------------
// Daemon leg
// ---------------------------------------------------------------------------

export type DaemonToHub =
  /** Answer to the hub's challenge. The only frame accepted before registration. */
  | { t: "register"; v: number; daemonId: string; publicKey: string; sig: string }
  | { t: "data"; sessionId: SessionId; rseq: number; payload: SealedPayload }
  | { t: "close"; sessionId: SessionId; code: RefusalCode | "done"; message?: string }
  /** Cumulative acknowledgement: how many frames this leg has actually taken in. */
  | { t: "ack"; sessionId: SessionId; received: number }
  | { t: "pong" }
  /**
   * The public relay forwards a webhook request to the pinned daemon. The body
   * stays opaque base64url data; only the local daemon decides what it means.
   */
  | {
      t: "webhook_response";
      requestId: string;
      status: number;
      body: SealedPayload;
      contentType?: string;
    };

export type HubToDaemon =
  /** Sent on connect. The daemon signs `nonce` to prove which daemon it is. */
  | { t: "challenge"; v: number; nonce: string }
  | { t: "registered"; daemonId: string; instanceId: string }
  /** A client has arrived and wants a session. No identity is asserted here. */
  | { t: "open"; sessionId: SessionId }
  | { t: "data"; sessionId: SessionId; rseq: number; payload: SealedPayload }
  | { t: "close"; sessionId: SessionId; code: RefusalCode | "done"; message?: string }
  | { t: "ack"; sessionId: SessionId; received: number }
  | { t: "refused"; code: RefusalCode; message: string }
  | { t: "ping" }
  /**
   * An unauthenticated-by-device webhook, scoped by its own routine secret.
   * The hub forwards it over the already-open daemon leg and never executes it.
   */
  | {
      t: "webhook_request";
      requestId: string;
      routineId: string;
      secret: string;
      body: SealedPayload;
      contentType?: string;
    };

// ---------------------------------------------------------------------------
// Client leg
// ---------------------------------------------------------------------------

export type ClientToHub =
  | { t: "data"; rseq: number; payload: SealedPayload }
  | { t: "ack"; received: number }
  | { t: "pong" };

export type HubToClient =
  /**
   * The hub found the daemon and opened a session.
   *
   * `publicKey` is here so a client can check it against the `daemonId` it
   * pinned. The hub is not trusted to have told the truth; the fingerprint
   * check is what makes this answer verifiable rather than believed.
   */
  | { t: "linked"; v: number; sessionId: SessionId; daemonId: string; publicKey: string }
  | { t: "data"; rseq: number; payload: SealedPayload }
  | { t: "ack"; received: number }
  | { t: "refused"; code: RefusalCode; message: string }
  /** The daemon leg went away. Not a hub failure, and not recoverable in place. */
  | { t: "peer_gone"; reason: string }
  | { t: "ping" };

/**
 * Parse a frame off the wire.
 *
 * Null rather than a throw for anything malformed. Every caller is reading
 * hostile input, where an exception is just a louder refusal that also risks
 * taking the connection down with it.
 */
export function parseFrame<T extends { t: string }>(raw: string): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (!("t" in parsed) || typeof parsed.t !== "string") return null;
  return parsed as T;
}

/** The bytes a daemon signs to prove which daemon it is to a hub. */
export function registrationLabel(): string {
  return `ompd-hub-register-v${PROTOCOL_VERSION}`;
}
