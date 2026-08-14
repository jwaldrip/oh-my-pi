/**
 * Where the daemon is and what this device is allowed to do there.
 *
 * Ported from the PWA's `config.ts`, with the browser taken out of it. The
 * original read `window.location`, `window.localStorage`, and the query string
 * directly; none of those exist on a phone, and two of them do not exist on a
 * Mac app either. What survives is the shape of the thing: an endpoint, a
 * scoped token, and the scopes the pairing granted.
 *
 * Storage is asynchronous here where the PWA's was synchronous. That is not a
 * style choice: every cross-platform store there is (IndexedDB on web, SQLite
 * on Android, a plist on Apple platforms) is asynchronous underneath, and a
 * synchronous facade over one is a lie that shows up as an empty screen on the
 * first launch after an install.
 *
 * The token used to live in this same AsyncStorage blob. It no longer does:
 * AsyncStorage is a plaintext file inside the app's own container, and both
 * mobile platforms fold that container into a device backup, which is
 * exactly where a bearer token for a daemon that runs code as the Mac user
 * must never sit. `platform/secrets.ts` (and its `.web.ts` counterpart) is
 * where the token lives now; this file keeps only the endpoint shape and the
 * scopes a pairing granted, plus the one-time move of a token still sitting
 * in a legacy blob onto a device that paired before this split existed.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { isHubUrl, isSocketUrl } from "@ompd/core/pairing";
import { deleteSecret, readSecret, writeSecret } from "./secrets";

const STORAGE_KEY = "ompd.connection";
const TOKEN_KEY = "ompd.connection.token";

/**
 * A paired device's link to its daemon, plus what the pairing granted it.
 *
 * Mirrors `@ompd/core/pairing`'s `Endpoint` union, with the token and scopes
 * a pairing carries independent of which transport reaches the daemon: a
 * socket this device dials itself, or a hub base plus the daemon pinned to it.
 */
export type Connection =
  | { transport: "direct"; url: string; token: string; scopes: string[] }
  | { transport: "hub"; hubUrl: string; daemonId: string; token: string; scopes: string[] };

export async function loadConnection(): Promise<Connection | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A store holding something that is not this shape is a store holding
    // nothing, and the pairing screen is the correct answer to that.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  // A device paired before this file split its storage in two has the token
  // sitting right inside this blob rather than in the keystore. Recognize
  // that by the token still being here and move it out before doing
  // anything else with what was read.
  if (typeof Reflect.get(parsed, "token") === "string") {
    return migrateLegacyBlob(parsed);
  }

  const token = await readSecret(TOKEN_KEY);
  if (token === null) {
    // Metadata with nothing to authenticate it is half a pairing, and half a
    // pairing is not a pairing: this must land on the pairing screen rather
    // than opening a socket the daemon is only going to refuse.
    return null;
  }
  return coerce({ ...parsed, token });
}

/**
 * A device paired before this file split its storage carries the token
 * inside the same blob `loadConnection` just read. `coerce` still accepts
 * that full shape unchanged, so the move is: validate it exactly the way it
 * always was, put the token in the keystore, then rewrite the blob without
 * it so no future load ever finds it here again.
 *
 * A keystore that refuses the write must not cost the device its only copy
 * of the token. This does not catch that failure: it propagates out of
 * `loadConnection` before the blob is touched, so a write that silently
 * failed can never look identical to a migration that actually happened.
 */
async function migrateLegacyBlob(parsed: object): Promise<Connection | null> {
  const connection = coerce(parsed);
  if (connection === null) return null;
  const { token, ...metadata } = connection;
  await writeSecret(TOKEN_KEY, token);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(metadata));
  return connection;
}

export async function saveConnection(connection: Connection): Promise<void> {
  const { token, ...metadata } = connection;
  // The secret goes into the keystore before the metadata reaches
  // AsyncStorage. A crash or kill between the two leaves either nothing
  // recorded at all, or a keystore entry with no metadata pointing at it --
  // never a metadata row promising a credential that was never stored.
  await writeSecret(TOKEN_KEY, token);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(metadata));
}

export async function clearConnection(): Promise<void> {
  // Deleting a secret that already is not there is success, not a refusal
  // (see `secrets.ts`), so this runs unconditionally rather than checking
  // whether the metadata row still exists first. Both halves are attempted
  // even if one of them rejects: a keystore error clearing the secret must
  // not leave the metadata row behind pointing at a credential that is
  // gone, and a storage error must not leave the secret behind believing a
  // pairing that no longer has an endpoint attached to it.
  const results = await Promise.allSettled([deleteSecret(TOKEN_KEY), AsyncStorage.removeItem(STORAGE_KEY)]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

/**
 * Exported because a token arriving from outside the app (a pairing deep link,
 * a pasted URL) is untrusted input in exactly the same way a stored blob is,
 * and both go through one door.
 *
 * A device paired before endpoints existed stored `{url, token, scopes}` with
 * no `transport` tag. That `url` is a socket the device was already dialling
 * directly, so an untagged blob with one becomes a `direct` connection here
 * rather than being dropped back to the pairing screen the first time this
 * ships to a device that paired under the old shape.
 */
export function coerce(value: unknown): Connection | null {
  if (typeof value !== "object" || value === null) return null;
  const token: unknown = Reflect.get(value, "token");
  if (typeof token !== "string" || token.length === 0) return null;
  const scopesRaw: unknown = Reflect.get(value, "scopes");
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((scope): scope is string => typeof scope === "string")
    : [];

  const transport: unknown = Reflect.get(value, "transport");
  if (transport === "hub") {
    const hubUrl: unknown = Reflect.get(value, "hubUrl");
    const daemonId: unknown = Reflect.get(value, "daemonId");
    if (typeof hubUrl !== "string" || !isHubUrl(hubUrl)) return null;
    if (typeof daemonId !== "string" || daemonId.length === 0) return null;
    return { transport: "hub", hubUrl, daemonId, token, scopes };
  }

  // A tag of "direct" and the untagged legacy shape resolve the same way: a
  // socket URL under the key both of them use. Anything else naming a
  // transport this app does not have is a refusal, not a guess.
  if (transport !== undefined && transport !== "direct") return null;
  const url: unknown = Reflect.get(value, "url");
  if (typeof url !== "string" || !isSocketUrl(url)) return null;
  return { transport: "direct", url, token, scopes };
}
