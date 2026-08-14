/**
 * The client-to-daemon handshake, carried by the hub and opaque to it.
 *
 * Signed ephemeral Diffie-Hellman. Both sides contribute a fresh X25519 key,
 * the daemon signs the transcript with its long-term Ed25519 identity, and the
 * session key comes from the ephemerals. Three properties fall out, each of
 * them a requirement rather than a nicety:
 *
 * **The daemon is authenticated; the hub is not.** A client pins a `daemonId`,
 * which is the fingerprint of the daemon's public key, so the hub cannot answer
 * for a daemon whose private half it does not hold. The worst a hostile hub can
 * do is refuse, or route to something that then fails this check.
 *
 * **The session key is forward-secret.** Both DH halves are ephemeral, so a
 * daemon identity key leaking later does not open traffic captured today. A
 * static-key seal would have been less code and would not have this.
 *
 * **The bearer token is never in the clear.** It travels sealed under the
 * session key, is opened only by the daemon, and is handed to the same
 * `authenticate` the local websocket path calls. The hub cannot read it, and no
 * new kind of credential was invented in order to avoid showing it.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonical, fromBase64UrlExact, toBase64Url, toHex, utf8 } from "./bytes.ts";
import { type ChannelKeys, deriveChannelKeys } from "./channel.ts";
import { type DaemonId, ID_PATTERN, keyMatchesId, signWith, verifyWith } from "./identity.ts";
import { PROTOCOL_VERSION, SESSION_ID_PATTERN, type SessionId } from "./protocol.ts";

const NONCE_BYTES = 32;
const X25519_BYTES = 32;

export type HandshakeFailure = "version_mismatch" | "unverifiable" | "bad_request";

/** Thrown when a handshake cannot complete. Always a refusal, never a retry. */
export class HandshakeError extends Error {
  readonly code: HandshakeFailure;

  constructor(code: HandshakeFailure, message: string) {
    super(message);
    this.name = "HandshakeError";
    this.code = code;
  }
}

/** First message: the client opens, asserting nothing but what it wants. */
export interface ClientHello {
  readonly t: "hello";
  readonly v: number;
  readonly daemonId: DaemonId;
  readonly nonce: string;
  /** Ephemeral X25519 public key, base64url. */
  readonly eph: string;
}

/** Second message: the daemon answers and proves which daemon it is. */
export interface DaemonAuth {
  readonly t: "auth";
  readonly nonce: string;
  readonly eph: string;
  readonly sig: string;
}

/** Third message, sealed: the client presents its credential. */
export interface ClientCredential {
  readonly t: "credential";
  readonly token: string;
}

/** Fourth message, sealed: the daemon accepts, naming who it decided you are. */
export interface SessionReady {
  readonly t: "ready";
  readonly deviceId: string;
}

export interface TranscriptInput {
  daemonId: DaemonId;
  sessionId: SessionId;
  clientNonce: string;
  clientEph: string;
  daemonNonce: string;
  daemonEph: string;
}

/**
 * Everything both sides hash to reach the same key.
 *
 * Length-prefixed rather than delimiter-joined. One of these fields is a
 * session id chosen by the hub, which is the party this protocol does not
 * trust, so field boundaries are stated rather than inferred from a separator
 * that a hostile value might contain.
 *
 * `sessionId` is included so a hub cannot splice two sessions together, and
 * `daemonId` so it cannot quietly re-point a client at a different machine.
 * Either substitution changes the transcript, the two sides derive different
 * keys, and the first sealed frame fails to open.
 */
export function handshakeTranscript(input: TranscriptInput): Uint8Array {
  return sha256(
    canonical([
      `ompd-tunnel-v${PROTOCOL_VERSION}`,
      input.daemonId,
      input.sessionId,
      input.clientNonce,
      input.clientEph,
      input.daemonNonce,
      input.daemonEph,
    ]),
  );
}

/** The bytes a daemon signs to bind its identity to this exact handshake. */
export function daemonSignedBytes(transcript: Uint8Array): Uint8Array {
  return utf8(`ompd-tunnel-daemon-v${PROTOCOL_VERSION}|${toHex(transcript)}`);
}

/**
 * Reject anything that is not a well-formed handshake field before it reaches
 * the transcript. Canonical encoding makes the boundaries unambiguous; this
 * makes the contents a known shape too, so a peer cannot smuggle structure into
 * a field that is supposed to be 32 bytes of randomness.
 */
function requireField(value: unknown, bytes: number, what: string): string {
  if (typeof value !== "string" || fromBase64UrlExact(value, bytes) === null) {
    throw new HandshakeError("bad_request", `${what} was not ${bytes} bytes of base64url`);
  }
  return value;
}

function requireSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new HandshakeError("bad_request", "session id was not a plain identifier");
  }
  return sessionId;
}

function sharedSecret(mine: Uint8Array, theirs: string): Uint8Array {
  const peer = fromBase64UrlExact(theirs, X25519_BYTES);
  if (peer === null) throw new HandshakeError("bad_request", "ephemeral key was not 32 bytes of base64url");
  try {
    return x25519.getSharedSecret(mine, peer);
  } catch {
    // A low-order point, or an all-zero result. Either way there is no secret
    // here, and continuing would derive a key an attacker also knows.
    throw new HandshakeError("bad_request", "ephemeral key was not a usable X25519 point");
  }
}

// ---------------------------------------------------------------------------
// Client half
// ---------------------------------------------------------------------------

export interface ClientHandshake {
  readonly hello: ClientHello;
  /**
   * Finish against the daemon's answer.
   *
   * Throws on anything that does not verify, which is the only outcome besides
   * a key: there is no partial trust to fall back to.
   */
  accept(auth: DaemonAuth, opts: { sessionId: SessionId; publicKey: string }): Promise<ChannelKeys>;
}

/**
 * Begin a handshake against a pinned daemon id.
 *
 * `daemonId` must be the one this client paired with. Everything else about the
 * daemon, the public key included, arrives from the hub and is checked against
 * that pin rather than trusted.
 */
export function beginClientHandshake(daemonId: DaemonId): ClientHandshake {
  if (!ID_PATTERN.test(daemonId)) throw new HandshakeError("bad_request", "daemon id was not a fingerprint");

  const secret = x25519.utils.randomSecretKey();
  const eph = toBase64Url(x25519.getPublicKey(secret));
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  const hello: ClientHello = { t: "hello", v: PROTOCOL_VERSION, daemonId, nonce, eph };

  return {
    hello,
    async accept(auth, opts) {
      // The hub supplied this key. It is worth exactly as much as its
      // fingerprint agreeing with the id the client already pinned.
      if (!keyMatchesId(daemonId, opts.publicKey)) {
        throw new HandshakeError("unverifiable", "the key offered for this daemon is not its fingerprint");
      }
      const transcript = handshakeTranscript({
        daemonId,
        sessionId: requireSessionId(opts.sessionId),
        clientNonce: nonce,
        clientEph: eph,
        daemonNonce: requireField(auth.nonce, NONCE_BYTES, "daemon nonce"),
        daemonEph: requireField(auth.eph, X25519_BYTES, "daemon ephemeral key"),
      });
      if (typeof auth.sig !== "string" || !verifyWith(opts.publicKey, daemonSignedBytes(transcript), auth.sig)) {
        throw new HandshakeError("unverifiable", "daemon did not prove possession of its identity key");
      }
      return deriveChannelKeys(sharedSecret(secret, auth.eph), transcript);
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon half
// ---------------------------------------------------------------------------

export interface DaemonHandshake {
  readonly auth: DaemonAuth;
  readonly keys: ChannelKeys;
}

/**
 * Answer a client's hello.
 *
 * Establishes a confidential channel and proves which daemon is on this end. It
 * authenticates nobody: the client is still anonymous here and stays that way
 * until it sends a credential through the channel this returns.
 */
export async function answerClientHandshake(input: {
  hello: ClientHello;
  sessionId: SessionId;
  daemonId: DaemonId;
  privateKey: string;
}): Promise<DaemonHandshake> {
  if (input.hello.v !== PROTOCOL_VERSION) {
    throw new HandshakeError(
      "version_mismatch",
      `client spoke v${input.hello.v}, this daemon speaks v${PROTOCOL_VERSION}`,
    );
  }
  // A client that asked for a different machine has been misrouted, and
  // answering anyway would make the hub's routing table the thing that decides
  // which daemon you reached.
  if (input.hello.daemonId !== input.daemonId) {
    throw new HandshakeError("unverifiable", "client asked for a different daemon");
  }

  const clientNonce = requireField(input.hello.nonce, NONCE_BYTES, "client nonce");
  const clientEph = requireField(input.hello.eph, X25519_BYTES, "client ephemeral key");
  const secret = x25519.utils.randomSecretKey();
  const eph = toBase64Url(x25519.getPublicKey(secret));
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  const transcript = handshakeTranscript({
    daemonId: input.daemonId,
    sessionId: requireSessionId(input.sessionId),
    clientNonce,
    clientEph,
    daemonNonce: nonce,
    daemonEph: eph,
  });

  return {
    auth: { t: "auth", nonce, eph, sig: signWith(input.privateKey, daemonSignedBytes(transcript)) },
    keys: await deriveChannelKeys(sharedSecret(secret, clientEph), transcript),
  };
}
