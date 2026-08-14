/**
 * Pairing has to outlive the process, and revocation has to outlive it too.
 *
 * These tests are written against `DeviceAuth` and a real file-backed store,
 * because the property under test is precisely the one an in-memory double
 * cannot have: a credential issued by one instance must be honoured by the
 * next one, and a credential withdrawn by either must be refused by both.
 *
 * The other half is that "long lived" never becomes "unrevocable". Every way
 * a token can end is asserted here: the device is revoked, the token row is
 * revoked, or it is rotated out from under itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_READ, Store, type Device } from "@ompd/core";
import { DeviceAuth, PairingError, hashToken } from "../src/gateway/auth.ts";

const paths: string[] = [];
const stores: Store[] = [];

function freshPath(): string {
  const path = `/tmp/ompd-auth-${crypto.randomUUID()}.db`;
  paths.push(path);
  return path;
}

function open(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function device(id: string, scopes: string[]): Device {
  return {
    id,
    name: id,
    publicKey: `pk_${id}`,
    scopes,
    createdAt: new Date().toISOString(),
  };
}

/** A store with one device row, ready to be issued a credential. */
function seeded(scopes: string[] = [SCOPE_READ]): { store: Store; path: string; auth: DeviceAuth } {
  const path = freshPath();
  const store = open(path);
  store.addDevice(device("dev_phone", scopes));
  return { store, path, auth: new DeviceAuth({ store }) };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

describe("a credential outliving the process", () => {
  test("a token issued before a restart still authenticates after one", () => {
    const first = seeded();
    const token = first.auth.issueToken("dev_phone");
    expect(first.auth.resolveActor(token)?.deviceId).toBe("dev_phone");
    first.store.close();
    stores.pop();

    // A second daemon, on the same state directory, with no memory of the
    // first. This is a restart, and it must change nothing.
    const store = open(first.path);
    const auth = new DeviceAuth({ store });
    expect(auth.resolveActor(token)?.deviceId).toBe("dev_phone");
  });

  test("a cold instance needs no warm-up to accept a token", () => {
    // Guards against a cache that is consulted before the store: an
    // implementation that only answered from memory would pass the test above
    // if the token happened to be resolved once first. Here it never is.
    const first = seeded();
    const token = first.auth.issueToken("dev_phone");
    first.store.close();
    stores.pop();

    const auth = new DeviceAuth({ store: open(first.path) });
    expect(auth.resolveActor(token)).not.toBeNull();
  });

  test("an invented token is refused", () => {
    const { auth } = seeded();
    expect(auth.resolveActor("not-a-real-token")).toBeNull();
  });
});

describe("ending a credential", () => {
  test("revoking the device refuses its token, across a restart", () => {
    const first = seeded();
    const token = first.auth.issueToken("dev_phone");
    first.auth.revoke("dev_phone");
    expect(first.auth.resolveActor(token)).toBeNull();
    first.store.close();
    stores.pop();

    // Revocation a restart undid would not be revocation.
    const auth = new DeviceAuth({ store: open(first.path) });
    expect(auth.resolveActor(token)).toBeNull();
  });

  test("revoking the device revokes its token rows, not just the device row", () => {
    const { store, auth } = seeded();
    const token = auth.issueToken("dev_phone");
    auth.revoke("dev_phone");

    const row = store.findAuthTokenByHash(hashToken(token));
    expect(row?.revokedAt).toBeDefined();
  });

  test("a revoked token row is refused even while its device is live", () => {
    const { store, auth } = seeded();
    const token = auth.issueToken("dev_phone");
    const row = store.findAuthTokenByHash(hashToken(token));
    store.revokeAuthToken(row?.id ?? "");

    expect(store.getDevice("dev_phone")?.revokedAt).toBeUndefined();
    expect(auth.resolveActor(token)).toBeNull();
  });

  test("a revoked device cannot be issued a replacement", () => {
    const { auth } = seeded();
    auth.revoke("dev_phone");
    expect(() => auth.issueToken("dev_phone")).toThrow(PairingError);
    expect(() => auth.rotateToken("dev_phone")).toThrow(PairingError);
  });
});

describe("scopes", () => {
  test("scopes come from the device row, not from the token", () => {
    // A token that carried its own scopes would make narrowing a device a
    // reissue-everything operation, and would make a leaked token permanently
    // as powerful as the day it was minted.
    const { store, auth } = seeded([SCOPE_READ, SCOPE_MANAGE, SCOPE_APPROVE]);
    const token = auth.issueToken("dev_phone");
    expect(auth.resolveActor(token)?.scopes.toSorted()).toEqual(["approve", "manage", "read"]);

    store.addDevice(device("dev_phone", [SCOPE_READ]));

    // Same token, narrower authority, nothing reissued.
    expect(auth.resolveActor(token)?.scopes).toEqual([SCOPE_READ]);
  });

  test("widening the device row widens the same token", () => {
    // The mirror. Without it the test above would still pass if resolution
    // had simply stopped reading scopes at all.
    const { store, auth } = seeded([SCOPE_READ]);
    const token = auth.issueToken("dev_phone");

    store.addDevice(device("dev_phone", [SCOPE_READ, SCOPE_MANAGE]));
    expect(auth.resolveActor(token)?.scopes.toSorted()).toEqual(["manage", "read"]);
  });
});

describe("last_used_at throttling", () => {
  /**
   * A store that counts writes to `last_used_at`.
   *
   * The assertion has to be on the number of writes, not on the timestamp
   * changing: the column carries the real wall clock, and a burst inside one
   * millisecond would write the same string twice and look throttled when it
   * was not.
   */
  function counting(store: Store): { touches: () => number } {
    let touches = 0;
    const write = store.touchAuthToken.bind(store);
    store.touchAuthToken = (id: string): void => {
      touches += 1;
      write(id);
    };
    return { touches: () => touches };
  }

  test("a burst of requests costs one write", () => {
    // Every authenticated call presents a token. Stamping the row on each one
    // turns every read into a WAL write, which is what this throttle exists
    // to prevent.
    let now = 1_000_000;
    const path = freshPath();
    const store = open(path);
    store.addDevice(device("dev_phone", [SCOPE_READ]));
    const counter = counting(store);
    const auth = new DeviceAuth({ store, touchIntervalMs: 60_000, now: () => now });

    const token = auth.issueToken("dev_phone");
    for (let i = 0; i < 20; i += 1) expect(auth.resolveActor(token)).not.toBeNull();
    expect(counter.touches()).toBe(1);

    now += 59_000;
    auth.resolveActor(token);
    expect(counter.touches()).toBe(1);

    // And the one write is real: the column is populated, not merely skipped.
    expect(store.findAuthTokenByHash(hashToken(token))?.lastUsedAt).toBeDefined();
  });

  test("the stamp is refreshed once the interval has passed", () => {
    // The mirror of the test above: a throttle that never let a second write
    // through would pass that one and make the column useless.
    let now = 1_000_000;
    const path = freshPath();
    const store = open(path);
    store.addDevice(device("dev_phone", [SCOPE_READ]));
    const counter = counting(store);
    const auth = new DeviceAuth({ store, touchIntervalMs: 60_000, now: () => now });

    const token = auth.issueToken("dev_phone");
    auth.resolveActor(token);

    now += 60_001;
    auth.resolveActor(token);
    expect(counter.touches()).toBe(2);
  });

  test("checking a token for reuse does not stamp it", () => {
    // The daemon asks this of the token file at every start. A start is not a
    // use, and recording one would make the column lie about idle devices.
    const { store, auth } = seeded();
    const token = auth.issueToken("dev_phone");

    expect(auth.hasLiveToken("dev_phone", token)).toBe(true);
    expect(store.findAuthTokenByHash(hashToken(token))?.lastUsedAt).toBeUndefined();
  });

  test("a token is only live for the device it was issued to", () => {
    const { store, auth } = seeded();
    store.addDevice(device("dev_laptop", [SCOPE_READ]));
    const token = auth.issueToken("dev_phone");

    expect(auth.hasLiveToken("dev_laptop", token)).toBe(false);
  });
});

describe("rotation", () => {
  test("the old token stops working and the new one starts", () => {
    const { auth } = seeded();
    const before = auth.issueToken("dev_phone");
    const rotated = auth.rotateToken("dev_phone", before);

    expect(auth.resolveActor(before)).toBeNull();
    expect(auth.resolveActor(rotated.token)?.deviceId).toBe("dev_phone");
    expect(rotated.revoked).toBe(1);
  });

  test("a rotation survives a restart", () => {
    const first = seeded();
    const before = first.auth.issueToken("dev_phone");
    const rotated = first.auth.rotateToken("dev_phone", before);
    first.store.close();
    stores.pop();

    const auth = new DeviceAuth({ store: open(first.path) });
    expect(auth.resolveActor(before)).toBeNull();
    expect(auth.resolveActor(rotated.token)).not.toBeNull();
  });

  test("naming the presented token withdraws only that one", () => {
    // A device rotating its own credential means "this one". Sweeping the
    // device would sign out its other sessions as a side effect.
    const { auth } = seeded();
    const mine = auth.issueToken("dev_phone");
    const other = auth.issueToken("dev_phone");

    const rotated = auth.rotateToken("dev_phone", mine);
    expect(rotated.revoked).toBe(1);
    expect(auth.resolveActor(mine)).toBeNull();
    expect(auth.resolveActor(other)).not.toBeNull();
  });

  test("naming no token withdraws every credential the device holds", () => {
    // An operator rotating someone else's device holds none of its tokens to
    // name, and means all of them. Leaving one alive would leave whatever
    // leaked still working.
    const { auth } = seeded();
    const a = auth.issueToken("dev_phone");
    const b = auth.issueToken("dev_phone");

    const rotated = auth.rotateToken("dev_phone");
    expect(rotated.revoked).toBe(2);
    expect(auth.resolveActor(a)).toBeNull();
    expect(auth.resolveActor(b)).toBeNull();
    expect(auth.resolveActor(rotated.token)).not.toBeNull();
  });

  test("rotation is recorded in the audit log with neither token in it", () => {
    const { store, auth } = seeded();
    const before = auth.issueToken("dev_phone");
    const rotated = auth.rotateToken("dev_phone", before);

    const entries = store.listAudit();
    expect(entries[0]?.detail.origin).toBe("rotation");
    expect(entries[0]?.detail.revoked).toBe(1);
    expect(entries[0]?.actorDeviceId).toBe("dev_phone");
    // Neither the withdrawn credential nor its replacement is in the log. An
    // audit trail that recorded the secret would be the easiest place on the
    // machine to harvest one.
    expect(JSON.stringify(entries)).not.toContain(rotated.token);
    expect(JSON.stringify(entries)).not.toContain(before);
  });
});
