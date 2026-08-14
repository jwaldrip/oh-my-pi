/**
 * The daemon's long-term identity, on disk.
 *
 * One file, one value: the private seed. The public key and the daemon id are
 * derived from it, so the file cannot disagree with itself, and a daemon that
 * has been restored from a backup is the same daemon rather than a new one
 * wearing the old id.
 *
 * Written 0600 inside a home that is already 0700. Losing this file means
 * losing the identity every client pinned, so it is created once and never
 * rewritten.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonKeyPair, generateIdentity, identityFromPrivate } from "@ompd/tunnel";

export function identityPath(home: string): string {
  return join(home, "identity");
}

/**
 * Load the daemon's identity, creating one the first time.
 *
 * A file that exists but cannot be parsed is an error rather than a reason to
 * mint a new identity: silently replacing it would change the daemon id and
 * every paired client would refuse the new key, which is a far more confusing
 * failure than a startup error naming the file.
 */
export function loadIdentity(home: string): DaemonKeyPair {
  const path = identityPath(home);
  if (existsSync(path)) {
    const seed = readFileSync(path, "utf8").trim();
    try {
      return identityFromPrivate(seed);
    } catch (cause) {
      throw new Error(
        `${path} is not a valid daemon identity: ${cause instanceof Error ? cause.message : cause}. ` +
          `Delete it to enroll as a new daemon, which every paired client will have to be told about.`,
      );
    }
  }

  const identity = generateIdentity();
  writeFileSync(path, `${identity.privateKey}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return identity;
}
