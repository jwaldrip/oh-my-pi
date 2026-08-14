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
 * mobile platforms fold that container into a device backup, which is exactly
 * where a bearer token for a daemon that runs code as the Mac user must never
 * sit. `platform/secrets.ts` (and its `.web.ts` counterpart) is where every
 * saved connection's token lives; this file keeps only endpoint metadata, an
 * active-connection pointer, and one-time migrations from the former shapes.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { isHubUrl, isSocketUrl } from "@ompd/core/pairing";
import { deleteSecret, readSecret, writeSecret } from "./secrets";

const STORAGE_KEY = "ompd.connection";
const LEGACY_TOKEN_KEY = "ompd.connection.token";
const DEFAULT_CONNECTION_ID = "default";

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

/** A named pairing held by this device. Its token remains in the keychain. */
export interface SavedConnection {
  readonly id: string;
  readonly label: string;
  readonly connection: Connection;
}

/** The complete pairing set and the one Console must open. */
export interface ConnectionList {
  readonly connections: readonly SavedConnection[];
  readonly activeId: string | null;
}

type StoredConnection = Omit<Connection, "token">;
type StoredEntry = { readonly id: string; readonly label: string; readonly connection: StoredConnection };
type StoredList = { readonly connections: readonly StoredEntry[]; readonly activeId: string | null };

function tokenKeyFor(id: string): string {
  return `${LEGACY_TOKEN_KEY}.${id}`;
}

/** Load every usable pairing and the active pointer from durable storage. */
export async function loadConnections(): Promise<ConnectionList> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw === null) return emptyList();

  const parsed = parseJsonObject(raw);
  if (parsed === null) return emptyList();

  const stored = coerceStoredList(parsed);
  if (stored !== null) {
    const hydrated = await hydrate(stored);
    await cleanLegacyToken();
    return hydrated;
  }

  return migrateSinglePairing(parsed);
}

/** The connection Console should open, retained for callers that need only one. */
export async function loadConnection(): Promise<Connection | null> {
  const list = await loadConnections();
  return list.connections.find((entry) => entry.id === list.activeId)?.connection ?? null;
}

/**
 * Save a new pairing without replacing any earlier pairing, then select it.
 * The first pairing uses the stable `default` identity so the one-time
 * single-pairing migration can be retried safely after an interrupted launch.
 */
export async function saveConnection(connection: Connection, label?: string): Promise<SavedConnection> {
  const current = await loadConnections();
  const id = current.connections.length === 0 ? DEFAULT_CONNECTION_ID : mintId(current.connections);
  const saved: SavedConnection = {
    id,
    label: label ?? defaultLabel(connection, current.connections),
    connection,
  };

  // Put the credential in the keystore before writing metadata. A failed
  // metadata write can leave only an unreachable secret, never a visible
  // pairing that promises a credential the keystore did not accept.
  await writeSecret(tokenKeyFor(id), connection.token);
  await writeStoredList({
    connections: [...current.connections.map(toStoredEntry), toStoredEntry(saved)],
    activeId: id,
  });
  return saved;
}

/** Select a saved pairing without copying its bearer token through app state. */
export async function setActiveConnection(id: string): Promise<void> {
  const stored = await readStoredList();
  if (stored === null || !stored.connections.some((entry) => entry.id === id)) {
    throw new Error(`saved connection "${id}" does not exist`);
  }
  await writeStoredList({ ...stored, activeId: id });
}

/**
 * Remove one pairing and its one credential. If it was active, another saved
 * pairing becomes active; only deleting the final pairing returns the app to
 * its unpaired state.
 */
export async function clearConnection(id: string): Promise<void> {
  const stored = await readStoredList();
  const remaining = stored?.connections.filter((entry) => entry.id !== id) ?? [];
  const activeId = pickActiveId(stored?.activeId ?? null, remaining);
  const metadata =
    remaining.length === 0
      ? AsyncStorage.removeItem(STORAGE_KEY)
      : writeStoredList({ connections: remaining, activeId });

  // Attempt both halves even when metadata is already gone. The secret may
  // still be present after an interrupted prior deletion.
  const results = await Promise.allSettled([deleteSecret(tokenKeyFor(id)), metadata]);
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

  if (transport !== undefined && transport !== "direct") return null;
  const url: unknown = Reflect.get(value, "url");
  if (typeof url !== "string" || !isSocketUrl(url)) return null;
  return { transport: "direct", url, token, scopes };
}

async function migrateSinglePairing(parsed: object): Promise<ConnectionList> {
  const inlineToken = Reflect.get(parsed, "token");
  const token = typeof inlineToken === "string" ? inlineToken : await readSecret(LEGACY_TOKEN_KEY);
  const connection = coerce({ ...parsed, token });
  if (connection === null) return emptyList();

  const saved: SavedConnection = { id: DEFAULT_CONNECTION_ID, label: "Default", connection };
  // New secret first, then the list metadata. If the app dies before cleanup,
  // the former unsuffixed key is only an orphan and the retry is idempotent.
  await writeSecret(tokenKeyFor(saved.id), connection.token);
  await writeStoredList({ connections: [toStoredEntry(saved)], activeId: saved.id });
  await cleanLegacyToken();
  return { connections: [saved], activeId: saved.id };
}

/**
 * Once list metadata is durable, the unsuffixed key can only be an orphan.
 * Cleanup must not reject a usable pairing, but every later list load retries
 * it so a transient keystore refusal does not become permanent residue.
 */
async function cleanLegacyToken(): Promise<void> {
  try {
    await deleteSecret(LEGACY_TOKEN_KEY);
  } catch {
    // The new per-connection key remains the only credential this app reads.
  }
}

async function hydrate(stored: StoredList): Promise<ConnectionList> {
  const connections: SavedConnection[] = [];
  for (const entry of stored.connections) {
    const token = await readSecret(tokenKeyFor(entry.id));
    if (token === null) continue;
    const connection = coerce({ ...entry.connection, token });
    if (connection !== null) connections.push({ id: entry.id, label: entry.label, connection });
  }
  return { connections, activeId: pickActiveId(stored.activeId, connections) };
}

async function readStoredList(): Promise<StoredList | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  const parsed = parseJsonObject(raw);
  return parsed === null ? null : coerceStoredList(parsed);
}

async function writeStoredList(list: StoredList): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function coerceStoredList(value: object): StoredList | null {
  const rawEntries = Reflect.get(value, "connections");
  const activeId = Reflect.get(value, "activeId");
  if (!Array.isArray(rawEntries) || (activeId !== null && typeof activeId !== "string")) return null;

  const connections: StoredEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== "object" || rawEntry === null) return null;
    const id = Reflect.get(rawEntry, "id");
    const label = Reflect.get(rawEntry, "label");
    const connection = Reflect.get(rawEntry, "connection");
    if (typeof id !== "string" || id.length === 0 || typeof label !== "string" || label.length === 0) return null;
    if (typeof connection !== "object" || connection === null || Reflect.has(connection, "token")) return null;
    connections.push({ id, label, connection: connection as StoredConnection });
  }
  return { connections, activeId };
}

function toStoredEntry(saved: SavedConnection): StoredEntry {
  const { token: _token, ...connection } = saved.connection;
  return { id: saved.id, label: saved.label, connection };
}

function parseJsonObject(raw: string): object | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function pickActiveId<T extends { readonly id: string }>(activeId: string | null, connections: readonly T[]): string | null {
  return connections.some((entry) => entry.id === activeId) ? activeId : (connections[0]?.id ?? null);
}

function emptyList(): ConnectionList {
  return { connections: [], activeId: null };
}

function defaultLabel(connection: Connection, existing: readonly SavedConnection[]): string {
  const base = connection.transport === "hub" ? "Cloud" : "Local";
  if (!existing.some((entry) => entry.label === base)) return base;
  let suffix = 2;
  while (existing.some((entry) => entry.label === `${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function mintId(existing: readonly SavedConnection[]): string {
  let id: string;
  do {
    id = `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  } while (existing.some((entry) => entry.id === id));
  return id;
}
