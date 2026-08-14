/**
 * `platform/secrets.ts` and the persistence half of `platform/connection.ts`
 * that now runs on top of it.
 *
 * `react-native-keychain` is stubbed at its own boundary rather than by
 * faking `secrets.ts` itself: the property worth defending is that
 * `secrets.ts`'s own translation of the library's contract (`false` means
 * refused, a missing item is `null`, a delete that finds nothing is still a
 * success) is correct, and that `connection.ts` built on top of it actually
 * keeps every pairing's metadata and keychain secret apart. AsyncStorage is
 * an in-memory map because bun has no native bridge and a real store would
 * leak state across tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type FakeKeychainOptions = { service?: string };

function makeFakeKeychain() {
  const store = new Map<string, string>();
  let failNextWrite = false;
  let failNextReset = false;
  return {
    store,
    failNextWrite(value: boolean) {
      failNextWrite = value;
    },
    failNextReset(value: boolean) {
      failNextReset = value;
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
        if (failNextReset) {
          failNextReset = false;
          throw new Error("simulated keychain cleanup failure");
        }
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

import type { Connection } from "../src/platform/connection.ts";
const secrets = await import("../src/platform/secrets.ts");
const webSecrets = await import("../src/platform/secrets.web.ts");
const { clearConnection, loadConnection, loadConnections, saveConnection, setActiveConnection } = await import(
  "../src/platform/connection.ts"
);

const CONNECTION_KEY = "ompd.connection";
const LEGACY_TOKEN_KEY = "ompd.connection.token";
const DEFAULT_TOKEN_KEY = "ompd.connection.token.default";

beforeEach(() => {
  fakeKeychain.store.clear();
  fakeAsyncStorage.store.clear();
  fakeKeychain.failNextWrite(false);
  fakeKeychain.failNextReset(false);
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
const HUB: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.example.com",
  daemonId: "dmn_cloud",
  token: "tok_cloud",
  scopes: ["read", "write"],
};

describe("connection.ts: saved pairing list and keychain secrets", () => {
  test("saveConnection then loadConnection round-trips the active connection", async () => {
    await saveConnection(DIRECT);
    expect(await loadConnection()).toEqual(DIRECT);
  });

  test("saving a second pairing preserves the first pairing", async () => {
    const first = await saveConnection(DIRECT);
    const second = await saveConnection(HUB, "Cloud");

    const list = await loadConnections();
    expect(list.activeId).toBe(second.id);
    expect(list.connections).toEqual([first, second]);
    await setActiveConnection(first.id);
    expect(await loadConnection()).toEqual(DIRECT);
  });

  test("switching the active pairing persists across a reload", async () => {
    const first = await saveConnection(DIRECT);
    await saveConnection(HUB, "Cloud");

    await setActiveConnection(first.id);
    expect((await loadConnections()).activeId).toBe(first.id);
    expect(await loadConnection()).toEqual(DIRECT);
  });

  test("saveConnection never writes any token into AsyncStorage", async () => {
    await saveConnection(DIRECT);
    const raw = fakeAsyncStorage.store.get(CONNECTION_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      activeId: "default",
      connections: [{ id: "default", label: "Local", connection: { transport: "direct", url: DIRECT.url, scopes: DIRECT.scopes } }],
    });
    expect(raw).not.toContain(DIRECT.token);
  });

  test("a metadata row with an absent active secret is not a usable pairing", async () => {
    await saveConnection(DIRECT);
    fakeKeychain.store.delete(DEFAULT_TOKEN_KEY);
    expect(await loadConnection()).toBeNull();
  });

  test("clearConnection deletes the secret even when metadata is already gone", async () => {
    await saveConnection(DIRECT);
    fakeAsyncStorage.store.delete(CONNECTION_KEY);
    expect(fakeKeychain.store.has(DEFAULT_TOKEN_KEY)).toBe(true);

    await clearConnection("default");

    expect(fakeKeychain.store.has(DEFAULT_TOKEN_KEY)).toBe(false);
    expect(fakeAsyncStorage.store.has(CONNECTION_KEY)).toBe(false);
  });

  test("clearing the active pairing keeps another saved pairing and makes it active", async () => {
    const first = await saveConnection(DIRECT);
    const second = await saveConnection(HUB, "Cloud");

    await clearConnection(second.id);

    expect(await loadConnections()).toEqual({ connections: [first], activeId: first.id });
    expect(await loadConnection()).toEqual(DIRECT);
  });

  describe("legacy migration: a single pairing becomes the Default list entry", () => {
    const legacyBlob = { url: "ws://127.0.0.1:7777/v1/socket", token: "tok_legacy", scopes: ["read", "write"] };

    test("moves an inline token into its namespaced keychain entry and leaves no token in metadata", async () => {
      fakeAsyncStorage.store.set(CONNECTION_KEY, JSON.stringify(legacyBlob));

      const connection = await loadConnection();

      expect(connection).toEqual({ transport: "direct", url: legacyBlob.url, token: legacyBlob.token, scopes: legacyBlob.scopes });
      expect(fakeKeychain.store.get(DEFAULT_TOKEN_KEY)).toBe(legacyBlob.token);
      expect(fakeKeychain.store.has(LEGACY_TOKEN_KEY)).toBe(false);

      const rewritten = fakeAsyncStorage.store.get(CONNECTION_KEY);
      expect(rewritten).toBeDefined();
      expect(JSON.parse(rewritten as string)).toEqual({
        activeId: "default",
        connections: [
          { id: "default", label: "Default", connection: { transport: "direct", url: legacyBlob.url, scopes: legacyBlob.scopes } },
        ],
      });
      expect(rewritten).not.toContain(legacyBlob.token);
      expect(await loadConnection()).toEqual(connection);
    });

    test("migrates the former split-store single pairing exactly once", async () => {
      fakeAsyncStorage.store.set(
        CONNECTION_KEY,
        JSON.stringify({ transport: "direct", url: DIRECT.url, scopes: DIRECT.scopes }),
      );
      fakeKeychain.store.set(LEGACY_TOKEN_KEY, DIRECT.token);

      expect(await loadConnections()).toEqual({
        activeId: "default",
        connections: [{ id: "default", label: "Default", connection: DIRECT }],
      });
      expect(fakeKeychain.store.get(DEFAULT_TOKEN_KEY)).toBe(DIRECT.token);
      expect(fakeKeychain.store.has(LEGACY_TOKEN_KEY)).toBe(false);
      expect(await loadConnection()).toEqual(DIRECT);
    });

    test("does not reject a successful migration when legacy-key cleanup fails", async () => {
      fakeAsyncStorage.store.set(CONNECTION_KEY, JSON.stringify(legacyBlob));
      fakeKeychain.store.set(LEGACY_TOKEN_KEY, "orphaned-old-token");
      fakeKeychain.failNextReset(true);

      expect(await loadConnection()).toEqual({
        transport: "direct",
        url: legacyBlob.url,
        token: legacyBlob.token,
        scopes: legacyBlob.scopes,
      });
      expect(fakeKeychain.store.get(DEFAULT_TOKEN_KEY)).toBe(legacyBlob.token);
      expect(fakeKeychain.store.get(LEGACY_TOKEN_KEY)).toBe("orphaned-old-token");
      expect(await loadConnection()).toEqual({
        transport: "direct",
        url: legacyBlob.url,
        token: legacyBlob.token,
        scopes: legacyBlob.scopes,
      });
      expect(fakeKeychain.store.has(LEGACY_TOKEN_KEY)).toBe(false);
    });

    test("a failed keystore write during migration leaves the legacy blob intact and rejects", async () => {
      fakeAsyncStorage.store.set(CONNECTION_KEY, JSON.stringify(legacyBlob));
      fakeKeychain.failNextWrite(true);

      await expect(loadConnection()).rejects.toThrow();

      expect(fakeAsyncStorage.store.get(CONNECTION_KEY)).toBe(JSON.stringify(legacyBlob));
      expect(fakeKeychain.store.has(DEFAULT_TOKEN_KEY)).toBe(false);
    });
  });
});

afterEach(() => {
  fakeKeychain.failNextWrite(false);
  fakeKeychain.failNextReset(false);
});
