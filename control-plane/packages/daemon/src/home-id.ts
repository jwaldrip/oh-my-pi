/**
 * A stable, opaque identity for a daemon's state directory.
 *
 * `ompd start` used to treat any healthy listener on its configured port as
 * itself, print "already listening", and exit 0. That is wrong whenever the
 * port belongs to a different daemon: the operator is told everything is fine
 * while their commands talk to a daemon holding a different token and
 * different agents. It is exactly how a demo instance can shadow the real one.
 *
 * So `/v1/health` publishes this, and the CLI compares before believing the
 * listener is its own.
 *
 * A hash rather than the path, because `/v1/health` is unauthenticated and a
 * home path contains a username. It is a fingerprint for equality, not a
 * secret and not a credential: anyone who can reach the port can read it, and
 * knowing it grants nothing.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fingerprint a state directory.
 *
 * The path is resolved through symlinks first, so `/tmp/x` and
 * `/private/tmp/x` on macOS produce one identity rather than two. A directory
 * that does not exist yet still fingerprints, from its absolute form, because
 * the first `ompd start` asks this question before creating anything.
 */
export function homeIdFor(home: string): string {
  const absolute = resolve(home);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Not created yet. The absolute path is a fine identity until it is, and
    // both sides of the comparison resolve the same way once it exists.
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
