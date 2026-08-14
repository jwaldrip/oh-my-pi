/**
 * Where the daemon is and what this device is allowed to do there.
 *
 * A pairing flow hands over a URL, a scoped token, and the scopes it granted.
 * The token is the whole credential, so it is taken out of the address bar the
 * moment it is read: a URL survives in history, in a screenshot, and in
 * whatever the phone syncs to the cloud.
 */

const STORAGE_KEY = "ompd.connection";

export interface Connection {
  /** Socket endpoint without the token, e.g. `ws://127.0.0.1:7717/v1/socket`. */
  url: string;
  token: string;
  /**
   * Scopes the daemon granted at pairing. Empty means the pairing did not say,
   * in which case the UI stays optimistic and lets the daemon correct it: an
   * `error` frame carrying a scope code downgrades the approval controls.
   */
  scopes: string[];
}

/** Same origin as the page, which is where the daemon serves this bundle. */
export function defaultSocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/v1/socket`;
}

export function loadConnection(): Connection | null {
  const fromQuery = readQueryConnection();
  if (fromQuery) {
    saveConnection(fromQuery);
    return fromQuery;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return coerce(parsed);
  } catch {
    return null;
  }
}

export function saveConnection(connection: Connection): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export function clearConnection(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

function readQueryConnection(): Connection | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token === null || token.length === 0) return null;
  const url = params.get("url") ?? defaultSocketUrl();
  const scopes = (params.get("scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  params.delete("token");
  params.delete("url");
  params.delete("scopes");
  const query = params.toString();
  const clean = `${window.location.pathname}${query.length > 0 ? `?${query}` : ""}`;
  window.history.replaceState(null, "", clean);

  return { url, token, scopes };
}

function coerce(value: unknown): Connection | null {
  if (typeof value !== "object" || value === null) return null;
  const url: unknown = Reflect.get(value, "url");
  const token: unknown = Reflect.get(value, "token");
  const scopes: unknown = Reflect.get(value, "scopes");
  if (typeof url !== "string" || typeof token !== "string") return null;
  const parsedScopes = Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [];
  return { url, token, scopes: parsedScopes };
}
