/**
 * Which daemons this hub will carry traffic for.
 *
 * Enrollment is deliberately awkward, for the reason `docs/fleet.md` gives
 * about device pairing: a daemon that can enroll itself is a daemon anyone can
 * add. It takes the hub's operator credential, which is held by a person and
 * never by a daemon.
 *
 * The registry holds public keys and nothing else. There is no secret here to
 * steal, and a hub that loses this table entirely refuses every daemon rather
 * than admitting any, which is the right direction to fail.
 */

import { fingerprint, type DaemonId, ID_PATTERN } from "@ompd/tunnel";

export interface EnrolledDaemon {
  readonly daemonId: DaemonId;
  /** Raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  readonly label: string;
  readonly enrolledAt: string;
}

export interface DaemonRegistry {
  lookup(daemonId: DaemonId): Promise<EnrolledDaemon | null>;
  enroll(input: { publicKey: string; label: string }): Promise<EnrolledDaemon>;
  remove(daemonId: DaemonId): Promise<boolean>;
  list(): Promise<EnrolledDaemon[]>;
}

/** Thrown when an enrollment is malformed. Never for a merely unknown daemon. */
export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

/**
 * Derive the record from the key.
 *
 * The id is never accepted from the caller. Taking one would let an operator
 * enroll a key under someone else's id by mistake, and every downstream check
 * that compares the two would then be comparing the hub's own error against
 * itself.
 */
export function enrollmentFor(input: { publicKey: string; label: string }): EnrolledDaemon {
  let daemonId: DaemonId;
  try {
    daemonId = fingerprint(input.publicKey);
  } catch (cause) {
    throw new EnrollmentError(`not an Ed25519 public key: ${cause instanceof Error ? cause.message : cause}`);
  }
  const label = input.label.trim();
  if (label.length === 0 || label.length > 64) throw new EnrollmentError("label must be 1 to 64 characters");
  return { daemonId, publicKey: input.publicKey, label, enrolledAt: new Date().toISOString() };
}

export class MemoryRegistry implements DaemonRegistry {
  readonly #rows = new Map<DaemonId, EnrolledDaemon>();

  async lookup(daemonId: DaemonId): Promise<EnrolledDaemon | null> {
    if (!ID_PATTERN.test(daemonId)) return null;
    return this.#rows.get(daemonId) ?? null;
  }

  async enroll(input: { publicKey: string; label: string }): Promise<EnrolledDaemon> {
    const row = enrollmentFor(input);
    this.#rows.set(row.daemonId, row);
    return row;
  }

  async remove(daemonId: DaemonId): Promise<boolean> {
    return this.#rows.delete(daemonId);
  }

  async list(): Promise<EnrolledDaemon[]> {
    return [...this.#rows.values()];
  }
}

/**
 * The registry Cloud Run runs on.
 *
 * A hub instance keeps no copy. Every lookup is a read, because an operator who
 * removes a daemon expects it unreachable now rather than once some cache
 * expires, and a lookup is one indexed read against a store the hub is already
 * talking to.
 */
export interface RegistryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

const KEY_PREFIX = "ompd:hub:enrolled:";

export class StoredRegistry implements DaemonRegistry {
  readonly #store: RegistryStore;

  constructor(store: RegistryStore) {
    this.#store = store;
  }

  async lookup(daemonId: DaemonId): Promise<EnrolledDaemon | null> {
    if (!ID_PATTERN.test(daemonId)) return null;
    const raw = await this.#store.get(KEY_PREFIX + daemonId);
    if (raw === null) return null;
    const row = parseRow(raw);
    // A stored row whose key no longer hashes to its id has been tampered with
    // or written by an older, wrong version. Either way it is not evidence of
    // anything, so it is not honoured.
    if (row === null || row.daemonId !== daemonId) return null;
    return row;
  }

  async enroll(input: { publicKey: string; label: string }): Promise<EnrolledDaemon> {
    const row = enrollmentFor(input);
    await this.#store.set(KEY_PREFIX + row.daemonId, JSON.stringify(row));
    return row;
  }

  async remove(daemonId: DaemonId): Promise<boolean> {
    if (!ID_PATTERN.test(daemonId)) return false;
    return (await this.#store.del(KEY_PREFIX + daemonId)) > 0;
  }

  async list(): Promise<EnrolledDaemon[]> {
    const rows: EnrolledDaemon[] = [];
    for (const key of await this.#store.keys(`${KEY_PREFIX}*`)) {
      const raw = await this.#store.get(key);
      const row = raw === null ? null : parseRow(raw);
      if (row !== null) rows.push(row);
    }
    return rows;
  }
}

function parseRow(raw: string): EnrolledDaemon | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (!("daemonId" in parsed) || !("publicKey" in parsed) || !("label" in parsed) || !("enrolledAt" in parsed)) {
    return null;
  }
  const { daemonId, publicKey, label, enrolledAt } = parsed;
  if (typeof daemonId !== "string" || typeof publicKey !== "string") return null;
  if (typeof label !== "string" || typeof enrolledAt !== "string") return null;
  return { daemonId, publicKey, label, enrolledAt };
}
