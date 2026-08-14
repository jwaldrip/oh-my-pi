/**
 * Daemon identity: one Ed25519 keypair, and an id that is its fingerprint.
 *
 * The id being derived from the key is the load-bearing property. A daemon id
 * is not a name the hub assigns and can therefore reassign; it is a hash of the
 * public key, so "the key for daemon X" has exactly one answer and anyone
 * holding the id can check that the key they were handed is the right one.
 *
 * That is what stops the hub substituting its own key for a daemon a client
 * already trusts. A compromised hub can refuse to route, and it can route a
 * client to nothing, but it cannot hand over a different public key under the
 * same id without the client noticing the fingerprint disagrees.
 *
 * Curves come from `@noble/curves` rather than WebCrypto. Not a preference:
 * Bun 1.3.4 generates X25519 keys and then refuses to `deriveBits` with them,
 * and browser support for both curves is recent enough that a phone client
 * would need a polyfill regardless. An audited pure-JS implementation is the
 * only one of the options that behaves the same on every target this package
 * is imported from.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes, fromBase64UrlExact, toBase64Url, toHex, utf8 } from "./bytes.ts";

/** `dmn_` + the full SHA-256 of the public key, hex. */
export type DaemonId = string;

const ID_PREFIX = "dmn_";

/**
 * The fingerprint is not truncated.
 *
 * Ids elsewhere in ompd (`agt_`, `dev_`, `tok_`) are 16 hex of randomness,
 * because they only have to be unique. This one is a trust anchor: a client
 * pins it at pairing and then accepts any key that hashes to it, so its length
 * is the work an attacker must do to substitute a key of their own. Truncated
 * to 64 bits that is a target worth grinding for a machine identity meant to
 * live for years. Nothing types this by hand, so the full digest costs nothing.
 */
export const ID_PATTERN = /^dmn_[0-9a-f]{64}$/;

/** Ed25519 raw keys and seeds are all this long. */
const ED25519_BYTES = 32;
const SIGNATURE_BYTES = 64;

export interface DaemonKeyPair {
  readonly daemonId: DaemonId;
  /** Raw 32-byte public key, base64url. Safe to publish. */
  readonly publicKey: string;
  /** Raw 32-byte seed, base64url. Never leaves the daemon's home directory. */
  readonly privateKey: string;
}

/** Thrown when a key is malformed. Never thrown for a merely wrong key. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** The id for a public key. The only way an id is ever produced. */
export function fingerprint(publicKey: string): DaemonId {
  const raw = fromBase64UrlExact(publicKey, ED25519_BYTES);
  if (raw === null) throw new IdentityError("public key was not 32 bytes of base64url");
  return ID_PREFIX + toHex(sha256(raw));
}

/**
 * Whether this id is the fingerprint of this key.
 *
 * Every party holding an (id, key) pair calls this before trusting either half.
 * That is what makes the pair self-certifying rather than a claim, so it is a
 * boolean on every input: a malformed key is a mismatch, not an exception on a
 * refusal path.
 */
export function keyMatchesId(daemonId: DaemonId, publicKey: string): boolean {
  if (!ID_PATTERN.test(daemonId)) return false;
  try {
    return equalBytes(utf8(fingerprint(publicKey)), utf8(daemonId));
  } catch {
    return false;
  }
}

export function generateIdentity(): DaemonKeyPair {
  return identityFromPrivate(toBase64Url(ed25519.utils.randomSecretKey()));
}

/**
 * Rebuild a full identity from the stored seed.
 *
 * The daemon persists one value and derives the rest, so an identity file
 * cannot hold a public key that disagrees with its private half.
 */
export function identityFromPrivate(privateKey: string): DaemonKeyPair {
  const seed = fromBase64UrlExact(privateKey, ED25519_BYTES);
  if (seed === null) throw new IdentityError("private key was not 32 bytes of base64url");
  const publicKey = toBase64Url(ed25519.getPublicKey(seed));
  return { daemonId: fingerprint(publicKey), publicKey, privateKey };
}

export function signWith(privateKey: string, message: Uint8Array): string {
  const seed = fromBase64UrlExact(privateKey, ED25519_BYTES);
  if (seed === null) throw new IdentityError("private key was not 32 bytes of base64url");
  return toBase64Url(ed25519.sign(message, seed));
}

/**
 * Verify a signature. A malformed key or signature is a false, never a throw:
 * every caller is on a refusal path where an exception would be a second,
 * noisier way to say no.
 */
export function verifyWith(publicKey: string, message: Uint8Array, signature: string): boolean {
  const key = fromBase64UrlExact(publicKey, ED25519_BYTES);
  const sig = fromBase64UrlExact(signature, SIGNATURE_BYTES);
  if (key === null || sig === null) return false;
  try {
    return ed25519.verify(sig, message, key);
  } catch {
    // A signature that is well-formed base64url but not a curve point lands
    // here. Still just a no.
    return false;
  }
}
