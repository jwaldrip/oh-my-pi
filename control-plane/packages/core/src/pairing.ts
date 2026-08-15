/**
 * Where a device connects, as a value both ends can print and parse.
 *
 * The phone shipped unusable for a reason that had nothing to do with the
 * phone: the app suggested `ws://127.0.0.1:7777/v1/socket`, and on a phone
 * loopback is the phone. The operator was expected to already know the
 * daemon's address. The daemon is the only thing that knows it, so the daemon
 * says it, and this file is the shape of what it says.
 *
 * ## Deliberately no credential
 *
 * An endpoint is not a secret and nothing here carries one. The bearer token
 * stays where `ompd approve` puts it: printed once, copied by the operator,
 * typed into its own field. Putting it in a URL alongside the address would
 * read as convenient and would push a long-lived credential through clipboard
 * history, shell history, and -- once anything registers this scheme -- OS
 * deep-link dispatch, all of which are logged in places a token should never
 * be. The pairing code is not a substitute either: it is short by design and
 * authorizes nothing, and a device that could spend one to collect a token
 * would have turned six digits into a credential.
 *
 * So this is an address, the operator remains the one who hands over the
 * credential, and the two halves stay separate.
 *
 * ## Two transports, because there are two situations
 *
 * `direct` is a websocket the device opens itself: loopback for a client on
 * the same machine, a LAN address for a phone on the same network. `hub` is a
 * daemon reached through a relay it dialled out to, which is the only thing
 * that works when the laptop is behind NAT. A hub endpoint is not a URL the
 * client opens: it is a hub base plus the daemon's pinned fingerprint, because
 * the session inside it is sealed to that daemon and the relay is not a party
 * to it. See `docs/hub.md`.
 */

/** Scheme both endpoint forms share. */
export const ENDPOINT_SCHEME = "ompd:";

export type Endpoint =
  | { transport: "direct"; url: string }
  | { transport: "hub"; hubUrl: string; daemonId: string };

/** How far an endpoint reaches, which is the only thing an operator picking one cares about. */
export type EndpointReach = "same-machine" | "same-network" | "anywhere";

export interface EndpointOffer {
  endpoint: Endpoint;
  reach: EndpointReach;
  /** Why this one, in the words a chooser needs: what it reaches and what it does not. */
  note: string;
}

/** Schemes a direct endpoint may name. Anything else is not a daemon socket. */
const SOCKET_SCHEMES: Record<string, true> = { "ws:": true, "wss:": true };

/** Schemes a hub base may name. `ws:` is allowed for a local hub under test. */
const HUB_SCHEMES: Record<string, true> = { "ws:": true, "wss:": true };

export function encodeEndpoint(endpoint: Endpoint): string {
  if (endpoint.transport === "direct") return endpoint.url;
  const params = new URLSearchParams({ url: endpoint.hubUrl, daemon: endpoint.daemonId });
  return `ompd://hub?${params.toString()}`;
}

/**
 * A pasted or typed string to an endpoint, or null.
 *
 * Null for anything not usable, because this is the door untrusted input comes
 * through. A bare websocket URL is a direct endpoint, which is what an
 * operator copying one line from `ompd approve` will paste. An `https://` page
 * is refused rather than coerced: it is not a socket, and treating one as an
 * endpoint is how a bearer token ends up posted to a website.
 */
export function parseEndpoint(raw: string): Endpoint | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol === ENDPOINT_SCHEME) {
    // `ompd://hub` parses with `hub` as the host. Checking it keeps a future
    // `ompd://something-else` from being read as a hub endpoint.
    if (parsed.host !== "hub") return null;
    const hubUrl = parsed.searchParams.get("url");
    const daemonId = parsed.searchParams.get("daemon");
    if (hubUrl === null || daemonId === null) return null;
    if (daemonId.length === 0 || !isHubUrl(hubUrl)) return null;
    // A credential must never ride along, so one that does is a refusal
    // rather than something to quietly drop: the operator pasted something
    // they believe carries their token, and silently discarding it would
    // leave them with a connection that fails to authenticate later.
    if (parsed.searchParams.has("token")) return null;
    return { transport: "hub", hubUrl: normalizeHubUrl(hubUrl), daemonId };
  }

  if (!isSocketUrl(trimmed)) return null;
  return { transport: "direct", url: trimmed };
}

/** Whether `value` is a websocket endpoint a device may open directly. */
export function isSocketUrl(value: string): boolean {
  const parsed = safeUrl(value);
  if (parsed === null) return false;
  if (SOCKET_SCHEMES[parsed.protocol] !== true) return false;
  return namesAHost(value);
}

/** Whether `value` is a usable hub base. */
export function isHubUrl(value: string): boolean {
  const parsed = safeUrl(value);
  if (parsed === null) return false;
  if (HUB_SCHEMES[parsed.protocol] !== true) return false;
  return namesAHost(value);
}

/**
 * Whether the string itself names a host, read before the URL parser gets it.
 *
 * `new URL("ws:///v1/socket")` does not fail and does not leave the host
 * empty: it takes the first path segment, so that string silently becomes a
 * connection to a host called `v1`. An operator who typed it plainly left the
 * address out. Checking the written authority is what keeps a typo from
 * becoming a connection somewhere nobody named.
 */
function namesAHost(value: string): boolean {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(value.trim());
  if (scheme === null) return false;
  const afterScheme = value.trim().slice(scheme[0].length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  return authority.length > 0;
}

/**
 * A hub base with any trailing slash removed.
 *
 * `TunnelSocket` appends `/v1/link/<id>` to whatever it is given, so a base
 * ending in `/` produces a double slash that some proxies route and others
 * 404. Normalizing once here means neither end has to remember.
 */
export function normalizeHubUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** One line naming an endpoint, for a CLI listing or a device's status row. */
export function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.transport === "direct"
    ? endpoint.url
    : `${endpoint.hubUrl} (daemon ${endpoint.daemonId})`;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * A completed pairing, ready to save without another network round trip.
 *
 * Unlike `Endpoint`, this carries the bearer token -- which is exactly why it
 * is never encoded as a `http(s)://` or `ompd://`/`ompctl://` URL. A token in
 * a URL rides through OS deep-link dispatch (Universal Links validation,
 * Android intent resolution, Handoff, Siri Suggestions indexing, share
 * sheets), all of which log or index it somewhere a long-lived credential
 * should never sit -- the same reasoning `Endpoint` above already rejects for
 * its own, non-secret case. `BUNDLE_PREFIX` is deliberately not a registered
 * URL scheme: no OS treats it as a link, so scanning one only ever reaches
 * this app's own in-app QR reader, never the OS deep-link path.
 *
 * A `PairingBundle` is minted by a device that already holds `approve` scope
 * -- the CLI (`ompd approve` / `ompd invite`) for a device's first pairing,
 * or an already-paired app for a second device -- immediately after that
 * device's own deliberate approval decision. It is never produced from an
 * unauthenticated pairing code by itself.
 */
export type PairedConnection =
  | { transport: "direct"; url: string; token: string; scopes: string[] }
  | { transport: "hub"; hubUrl: string; daemonId: string; token: string; scopes: string[] };

export interface PairingBundle {
  v: 1;
  /** The device name the approver chose, shown on the scanning side before it saves anything. */
  label: string;
  connection: PairedConnection;
}

/** Marks a scanned/pasted string as a pairing bundle, not a URL. See `PairingBundle` above. */
export const BUNDLE_PREFIX = "ompd-pair-v1:";

/** Render a bundle for a QR code or terminal display. Opaque text, not a link. */
export function encodePairingBundle(bundle: PairingBundle): string {
  return BUNDLE_PREFIX + toBase64Url(toUtf8(JSON.stringify(bundle)));
}

/** The inverse of `encodePairingBundle`, or null for anything malformed or foreign. */
export function parsePairingBundle(raw: string): PairingBundle | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(BUNDLE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(trimmed.slice(BUNDLE_PREFIX.length))));
  } catch {
    return null;
  }
  return coercePairingBundle(parsed);
}

function coercePairingBundle(value: unknown): PairingBundle | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.label !== "string") return null;
  const connection = coercePairedConnection(v.connection);
  if (connection === null) return null;
  return { v: 1, label: v.label, connection };
}

function coercePairedConnection(value: unknown): PairedConnection | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.token !== "string" || c.token.length === 0) return null;
  if (!Array.isArray(c.scopes) || !c.scopes.every((s) => typeof s === "string")) return null;
  const scopes = c.scopes as string[];
  if (c.transport === "direct" && typeof c.url === "string" && isSocketUrl(c.url)) {
    return { transport: "direct", url: c.url, token: c.token, scopes };
  }
  if (
    c.transport === "hub" &&
    typeof c.hubUrl === "string" &&
    isHubUrl(c.hubUrl) &&
    typeof c.daemonId === "string" &&
    c.daemonId.length > 0
  ) {
    return { transport: "hub", hubUrl: normalizeHubUrl(c.hubUrl), daemonId: c.daemonId, token: c.token, scopes };
  }
  return null;
}

/** Portable base64url, without assuming `Buffer` (Bun/CLI) or `btoa` (Hermes/app) exist. */
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "" : B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "" : B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const index = B64URL_ALPHABET.indexOf(ch);
    if (index === -1) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
