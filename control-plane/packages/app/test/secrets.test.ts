/**
 * `platform/secrets.ts` and the persistence half of `platform/connection.ts`
 * that now runs on top of it.
 *
 * `react-native-keychain` is stubbed at its own boundary rather than by
 * faking `secrets.ts` itself: the property worth defending is that
 * `secrets.ts`'s own translation of the library's contract (`false` means
 * refused, a missing item is `null`, a delete that finds nothing is still a
 * success) is correct, and that `connection.ts` built on top of it actually
 * gets the metadata/keystore split right -- not that a hand-rolled fake of
 * our own module agrees with itself. `@react-native-async-storage/async-storage`
 * is stubbed with a plain in-memory map for the same reason `connection.ts`
 * was never testable end to end before this file existed: bun has no native
 * bridge and no IndexedDB, and a real store would leak state across tests.
 *
 * Both mocks are registered before anything under test is imported, the same
 * way `rnw.ts` registers its mocks before the components that need them --
 * ES modules evaluate dependencies in source order, so a `mock.module` call
 * after the fact would be too late.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type FakeKeychainOptions = { service?: string };

function makeFakeKeychain() {
  const store = new Map<string, string>();
  let failNextWrite = false;

  return {
    store,
    failNextWrite(value: boolean) {
      failNextWrite = value;
    },
    module: {
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "AccessibleWhenUnlockedThisDeviceOnly" },
      getGenericPassword: async (options?: FakeKeychainOptions) => {
        const service = options?.service ?? "";
        const password = store.get(service);
        return password === undefined
          ? false
          : { service, username: service, password, storage: "KeystoreAESGCM_NoAuth" };
      },
      setGenericPassword: async (_username: string, password: string, options?: FakeKeychainOptions) => {
        const service = options?.service ?? "";
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated keychain failure");
        }
        store.set(service, password);
        return { service, storage: "KeystoreAESGCM_NoAuth" };
      },
      resetGenericPassword: async (options?: FakeKeychainOptions) => {
        store.delete(options?.service ?? "");
        return true;
      },
    },
  };
}

function makeFakeAsyncStorage() {
  const store = new Map<string, string>();
  return {
    store,
    module: {
      default: {
        getItem: async (key: string) => store.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: async (key: string) => {
          store.delete(key);
        },
      },
    },
  };
}

const fakeKeychain = makeFakeKeychain();
const fakeAsyncStorage = makeFakeAsyncStorage();

mock.module("react-native-keychain", () => fakeKeychain.module);
mock.module("@react-native-async-storage/async-storage", () => fakeAsyncStorage.module);

// Dynamic on purpose: a static import of any of these three modules would
// resolve before the two `mock.module` calls above could substitute them,
// the same reason `fleet-screen.test.tsx` imports `../src/screens/FleetScreen.tsx`
// dynamically after `./rnw.ts`'s mocks. `Connection` is type-only, so it is
// erased before it can pull the real module in early.
import type { Connection } from "../src/platform/connection.ts";
const secrets = await import("../src/platform/secrets.ts");
const webSecrets = await import("../src/platform/secrets.web.ts");
const { clearConnection, loadConnection, saveConnection } = await import("../src/platform/connection.ts");

const CONNECTION_KEY = "ompd.connection";
const TOKEN_KEY = "ompd.connection.token";

beforeEach(() => {
  fakeKeychain.store.clear();
  fakeAsyncStorage.store.clear();
  fakeKeychain.failNextWrite(false);
});

describe("secrets.ts: the native keystore seam", () => {
  test("round-trips a value through write, read, and delete", async () => {
    await secrets.writeSecret("k1", "sekrit");
    expect(await secrets.readSecret("k1")).toBe("sekrit");

    await secrets.deleteSecret("k1");
    expect(await secrets.readSecret("k1")).toBeNull();
  });

  test("reading a key nothing was ever written under is null, not a throw", async () => {
    expect(await secrets.readSecret("never-written")).toBeNull();
  });

  test("deleting a key that was never written is not a refusal", async () => {
    await expect(secrets.deleteSecret("never-written")).resolves.toBeUndefined();
  });

  test("a keystore that refuses the write surfaces as a rejection, not a silent no-op", async () => {
    fakeKeychain.failNextWrite(true);
    await expect(secrets.writeSecret("k2", "sekrit")).rejects.toThrow();
    // The refused write must not look like it landed.
    expect(await secrets.readSecret("k2")).toBeNull();
  });

  test("SECRETS_PERSIST_ACROSS_LAUNCHES is true: this is the target with a real keystore", () => {
    expect(secrets.SECRETS_PERSIST_ACROSS_LAUNCHES).toBe(true);
  });
});

describe("secrets.web.ts: the target with no keystore", () => {
  test("round-trips within the session, in memory", async () => {
    await webSecrets.writeSecret("w1", "sekrit");
    expect(await webSecrets.readSecret("w1")).toBe("sekrit");

    await webSecrets.deleteSecret("w1");
    expect(await webSecrets.readSecret("w1")).toBeNull();
  });

  test("never touches the real keystore or AsyncStorage stores", async () => {
    await webSecrets.writeSecret("w2", "sekrit");
    expect(fakeKeychain.store.size).toBe(0);
    expect(fakeAsyncStorage.store.size).toBe(0);
  });

  test("SECRETS_PERSIST_ACROSS_LAUNCHES is false: nothing here survives a reload", () => {
    expect(webSecrets.SECRETS_PERSIST_ACROSS_LAUNCHES).toBe(false);
  });
});

const DIRECT: Connection = { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_abc", scopes: ["read"] };

describe("connection.ts: metadata and token split across two stores", () => {
  test("saveConnection then loadConnection round-trips the full connection", async () => {
    await saveConnection(DIRECT);
    expect(await loadConnection()).toEqual(DIRECT);
  });

  test("saveConnection never writes the token into AsyncStorage", async () => {
    await saveConnection(DIRECT);
    const raw = fakeAsyncStorage.store.get(CONNECTION_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({ transport: "direct", url: DIRECT.url, scopes: DIRECT.scopes });
    expect(raw).not.toContain(DIRECT.token);
  });

  test("loadConnection returns null when metadata exists but the secret is absent", async () => {
    await saveConnection(DIRECT);
    fakeKeychain.store.delete(TOKEN_KEY);
    expect(await loadConnection()).toBeNull();
  });

  test("clearConnection deletes the secret even when the metadata row is already gone", async () => {
    await saveConnection(DIRECT);
    fakeAsyncStorage.store.delete(CONNECTION_KEY);
    expect(fakeKeychain.store.has(TOKEN_KEY)).toBe(true);

    await clearConnection();

    expect(fakeKeychain.store.has(TOKEN_KEY)).toBe(false);
    expect(fakeAsyncStorage.store.has(CONNECTION_KEY)).toBe(false);
  });

  test("clearConnection removes both halves of a normal pairing", async () => {
    await saveConnection(DIRECT);
    await clearConnection();
    expect(await loadConnection()).toBeNull();
    expect(fakeKeychain.store.has(TOKEN_KEY)).toBe(false);
    expect(fakeAsyncStorage.store.has(CONNECTION_KEY)).toBe(false);
  });

  describe("legacy migration: a device paired before the split", () => {
    const legacyBlob = { url: "ws://127.0.0.1:7777/v1/socket", token: "tok_legacy", scopes: ["read", "write"] };

    test("moves the token into the keystore and leaves no token behind in the metadata", async () => {
      fakeAsyncStorage.store.set(CONNECTION_KEY, JSON.stringify(legacyBlob));

      const connection = await loadConnection();

      expect(connection).toEqual({
        transport: "direct",
        url: legacyBlob.url,
        token: legacyBlob.token,
        scopes: legacyBlob.scopes,
      });
      expect(fakeKeychain.store.get(TOKEN_KEY)).toBe(legacyBlob.token);

      const rewritten = fakeAsyncStorage.store.get(CONNECTION_KEY);
      expect(rewritten).toBeDefined();
      const parsedRewritten: unknown = JSON.parse(rewritten as string);
      expect(parsedRewritten).not.toHaveProperty("token");
      expect(rewritten).not.toContain(legacyBlob.token);

      // The device must not be silently unpaired: a second load reads the
      // now-split store and gets the same connection back.
      expect(await loadConnection()).toEqual(connection);
    });

    test("a failed keystore write during migration leaves the legacy blob intact and rejects", async () => {
      fakeAsyncStorage.store.set(CONNECTION_KEY, JSON.stringify(legacyBlob));
      fakeKeychain.failNextWrite(true);

      await expect(loadConnection()).rejects.toThrow();

      // The only copy of the token was in this blob; it must still be there,
      // untouched, rather than half-migrated or dropped.
      expect(fakeAsyncStorage.store.get(CONNECTION_KEY)).toBe(JSON.stringify(legacyBlob));
      expect(fakeKeychain.store.has(TOKEN_KEY)).toBe(false);
    });
  });
});

afterEach(() => {
  fakeKeychain.failNextWrite(false);
});
