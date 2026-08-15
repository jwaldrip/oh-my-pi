/**
 * Pairing and device management.
 *
 * Two steps, and the split is the security property: `pair` records an intent
 * and grants nothing, `approve` is the operator act that writes a device row
 * and mints its token. The daemon refuses to grant a scope the approving
 * device does not itself hold, so this CLI cannot mint an account more
 * powerful than the one it is using. `invite` composes the two calls for the
 * common case where one operator is doing both; see its own doc comment for
 * why that composition grants nothing the two steps could not.
 */

import { randomUUID } from "node:crypto";
import type { Device } from "@ompd/core";
import {
  describeEndpoint,
  encodePairingBundle,
  type Endpoint,
  type EndpointOffer,
  type EndpointReach,
  type PairedConnection,
  type PairingBundle,
} from "@ompd/core/pairing";
import QRCode from "qrcode";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { age, table } from "../format.ts";

interface PairResponse {
  code?: unknown;
}

interface ApproveResponse {
  token?: unknown;
  /** The name the pairing client chose at `/v1/pair` time; absent means no QR code can be labeled. */
  name?: unknown;
}

interface RotateResponse {
  token?: unknown;
  deviceId?: unknown;
  revoked?: unknown;
  /** Present when the daemon also persisted the replacement, for its operator token. */
  tokenPath?: unknown;
}

interface DevicesResponse {
  devices?: Device[];
}

interface EndpointsResponse {
  offers?: EndpointOffer[];
}

/** Nearest reach first, since that is the one most operators will actually pick. */
const REACH_ORDER: readonly EndpointReach[] = ["same-machine", "same-network", "anywhere"];

/**
 * Where a device can point, fetched fresh rather than guessed.
 *
 * A loopback address used to be printed here directly, which means something
 * different on every machine it is copied to and nothing at all on a phone.
 * The daemon is the only thing that knows its own reachable addresses, so
 * asking it is the only way this line is ever right. A failure here is
 * reported, never thrown: whatever it returns, the caller still has to print
 * the token, which is the half of this output that cannot be produced again.
 */
export async function fetchEndpointOffers(ctx: CliContext): Promise<EndpointOffer[] | null> {
  try {
    const response = await api<EndpointsResponse>(ctx, "/v1/endpoints");
    return response.offers ?? [];
  } catch (err) {
    ctx.err(
      `  could not list reachable endpoints: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function printEndpointOffers(ctx: CliContext, offers: EndpointOffer[]): void {
  if (offers.length === 0) {
    ctx.out("  the daemon reported no reachable endpoints");
    return;
  }
  for (const reach of REACH_ORDER) {
    const forReach = offers.filter((offer) => offer.reach === reach);
    if (forReach.length === 0) continue;
    ctx.out(`  ${reach}`);
    for (const offer of forReach) {
      ctx.out(`    ${describeEndpoint(offer.endpoint)}`);
      ctx.out(`      ${offer.note}`);
    }
  }
}

/**
 * The endpoint a bundle should point at, picked by the same order an
 * operator reads in `printEndpointOffers` above. Null covers both a failed
 * lookup and an empty one -- the caller only needs to know whether there is
 * anything to encode, not why there isn't.
 */
function bestEndpointOffer(offers: EndpointOffer[] | null): EndpointOffer | null {
  if (offers === null) return null;
  for (const reach of REACH_ORDER) {
    const match = offers.find((offer) => offer.reach === reach);
    if (match !== undefined) return match;
  }
  return null;
}

/** `Endpoint` plus the credential a scanning device saves alongside it. */
function pairedConnectionFor(endpoint: Endpoint, token: string, scopes: string[]): PairedConnection {
  return endpoint.transport === "direct"
    ? { transport: "direct", url: endpoint.url, token, scopes }
    : { transport: "hub", hubUrl: endpoint.hubUrl, daemonId: endpoint.daemonId, token, scopes };
}

/**
 * The second half of a token's one-time printing: a QR code a phone can scan
 * instead of retyping it, and a fallback line for when it cannot. Both are
 * built from the token and scopes already on the screen above, so neither can
 * grant more than that text already did.
 *
 * The encoded bundle goes to this terminal and nowhere else -- never a log,
 * never a request body, never a file -- for the reason `PairingBundle`'s own
 * doc comment gives for rejecting a URL: it carries the token. A missing name
 * or endpoint is reported and skipped rather than thrown, because the token
 * is already printed and a QR failure must never read as the command itself
 * having failed.
 */
async function printPairingQr(
  ctx: CliContext,
  opts: { offers: EndpointOffer[] | null; label: string; token: string; scopes: string[] },
): Promise<void> {
  const offer = bestEndpointOffer(opts.offers);
  if (offer === null) {
    ctx.out("");
    ctx.out("  no reachable endpoint to encode; skipping the QR code");
    return;
  }

  const bundle: PairingBundle = {
    v: 1,
    label: opts.label,
    connection: pairedConnectionFor(offer.endpoint, opts.token, opts.scopes),
  };
  const encoded = encodePairingBundle(bundle);
  const qr = await QRCode.toString(encoded, { type: "terminal", small: true });

  ctx.out("");
  ctx.out('  or scan this with the app\'s "Scan a QR code instead" option on the pairing screen:');
  for (const line of qr.split("\n")) {
    if (line.length > 0) ctx.out(line);
  }
  ctx.out("");
  ctx.out("  can't scan it? paste this string into the app's manual pairing field instead:");
  ctx.out(`  ${encoded}`);
}

export async function pairCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "pair" }>,
): Promise<number> {
  const response = await api<PairResponse>(ctx, "/v1/pair", {
    anonymous: true,
    method: "POST",
    body: {
      name: cmd.name,
      // Bearer tokens are the credential today, so this records provenance
      // rather than proving anything. Inventing a keypair here and storing it
      // beside the token would look like proof without being any.
      publicKey: `cli:${randomUUID()}`,
    },
  });

  if (typeof response.code !== "string") {
    ctx.err("the daemon did not return a pairing code");
    return 1;
  }

  ctx.out(`pairing ${cmd.name} started`);
  ctx.out(`  code    ${response.code}`);
  ctx.out("");
  ctx.out("  approve it, from this machine or a device holding the approve scope:");
  ctx.out(`    ompd approve ${response.code} --scopes ${cmd.scopes.join(",")}`);
  ctx.out("");
  ctx.out("  the code expires in 10 minutes and can be spent once");
  ctx.out("");
  ctx.out("  where the device will point once approved:");
  const pairOffers = await fetchEndpointOffers(ctx);
  if (pairOffers !== null) printEndpointOffers(ctx, pairOffers);
  return 0;
}

export async function approveCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "approve" }>,
): Promise<number> {
  const response = await api<ApproveResponse>(ctx, "/v1/pairings/approve", {
    method: "POST",
    body: { code: cmd.code, scopes: cmd.scopes },
  });

  if (typeof response.token !== "string") {
    ctx.err("the daemon approved the pairing but returned no token");
    return 1;
  }

  // Printed exactly once. Only its hash is kept daemon-side, so there is no
  // route, file, or command that can produce it a second time; saying so here
  // is the difference between an operator copying it now and re-pairing later.
  ctx.out(`approved. scopes: ${cmd.scopes.join(", ")}`);
  ctx.out("");
  ctx.out(`  ${response.token}`);
  ctx.out("");
  ctx.out("  This token is shown once and is not recoverable. The daemon keeps only its");
  ctx.out("  hash. Copy it now; if you lose it, rotate or pair again.");
  ctx.out("  It lasts until you revoke the device or rotate the token.");

  // A separate call, and a separate paragraph: the token above is the
  // secret, the endpoints below are where to point the device holding it,
  // and a failure fetching the second must never cost the operator the
  // first, which the daemon cannot produce again.
  ctx.out("");
  ctx.out("  the token above is a secret; the endpoints below are not:");
  const approveOffers = await fetchEndpointOffers(ctx);
  if (approveOffers !== null) printEndpointOffers(ctx, approveOffers);

  if (typeof response.name === "string") {
    await printPairingQr(ctx, {
      offers: approveOffers,
      label: response.name,
      token: response.token,
      scopes: cmd.scopes,
    });
  } else {
    ctx.out("");
    ctx.out("  the daemon did not return the pairing's name, so no QR code was built");
  }
  return 0;
}

/**
 * `pair` and `approve`, run back to back with the operator's own token.
 *
 * The two-step form exists so a *different* device can hold the approve
 * decision -- a phone approving from wherever the operator already is, say.
 * This is the same two HTTP calls for the common case where the operator is
 * running both halves themselves and typing the code in between buys
 * nothing. It grants no more than `approve` already would: the daemon still
 * refuses any scope this shell's own token does not hold, so composing the
 * calls here cannot mint an account more powerful than one `approve` could.
 */
export async function inviteCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "invite" }>,
): Promise<number> {
  const pairResponse = await api<PairResponse>(ctx, "/v1/pair", {
    anonymous: true,
    method: "POST",
    body: {
      name: cmd.name,
      publicKey: `cli:${randomUUID()}`,
    },
  });

  if (typeof pairResponse.code !== "string") {
    ctx.err("the daemon did not return a pairing code");
    return 1;
  }

  const approveResponse = await api<ApproveResponse>(ctx, "/v1/pairings/approve", {
    method: "POST",
    body: { code: pairResponse.code, scopes: cmd.scopes },
  });

  if (typeof approveResponse.token !== "string") {
    ctx.err("the daemon approved the pairing but returned no token");
    return 1;
  }

  ctx.out(`invited ${cmd.name}. scopes: ${cmd.scopes.join(", ")}`);
  ctx.out("");
  ctx.out(`  ${approveResponse.token}`);
  ctx.out("");
  ctx.out("  This token is shown once and is not recoverable. The daemon keeps only its");
  ctx.out("  hash. Copy it now; if you lose it, rotate or invite again.");
  ctx.out("  It lasts until you revoke the device or rotate the token.");

  ctx.out("");
  ctx.out("  the token above is a secret; the endpoints below are not:");
  const inviteOffers = await fetchEndpointOffers(ctx);
  if (inviteOffers !== null) printEndpointOffers(ctx, inviteOffers);

  // Unlike `approve`, the name here is the operator's own typed positional
  // rather than a value read back off the wire: this command chose it, so
  // there is nothing to fall back on if it were somehow missing.
  await printPairingQr(ctx, {
    offers: inviteOffers,
    label: cmd.name,
    token: approveResponse.token,
    scopes: cmd.scopes,
  });
  return 0;
}

export async function devicesCommand(ctx: CliContext): Promise<number> {
  const response = await api<DevicesResponse>(ctx, "/v1/devices");
  const devices = response.devices ?? [];
  if (devices.length === 0) {
    ctx.out("no devices are paired");
    return 0;
  }

  const rows = devices.map((device) => [
    device.id,
    device.name,
    device.scopes.join(","),
    age(device.createdAt),
    device.revokedAt === undefined ? "active" : `revoked ${age(device.revokedAt)}`,
  ]);
  for (const line of table(["ID", "NAME", "SCOPES", "PAIRED", "STATE"], rows)) ctx.out(line);
  return 0;
}

export async function revokeCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "revoke" }>,
): Promise<number> {
  await api(ctx, `/v1/devices/${encodeURIComponent(cmd.deviceId)}`, { method: "DELETE" });
  ctx.out(`revoked ${cmd.deviceId}`);
  ctx.out("  its tokens stop working on the next request or frame");
  return 0;
}

/**
 * Replace a credential with a new one.
 *
 * The escape hatch that makes a token with no expiry acceptable. A token that
 * lives until revoked is only safe if withdrawing it is one command, and this
 * is that command: the old value stops working the moment the daemon answers,
 * whether it is on this machine, in a phone's local storage, or in someone
 * else's clipboard.
 */
export async function rotateCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "rotate" }>,
): Promise<number> {
  const response = await api<RotateResponse>(ctx, "/v1/tokens/rotate", {
    method: "POST",
    body: cmd.deviceId === undefined ? {} : { deviceId: cmd.deviceId },
  });

  if (typeof response.token !== "string") {
    ctx.err("the daemon rotated nothing: it returned no replacement token");
    return 1;
  }

  const deviceId = typeof response.deviceId === "string" ? response.deviceId : (cmd.deviceId ?? "");
  ctx.out(`rotated the token for ${deviceId}`);
  ctx.out("");
  ctx.out(`  ${response.token}`);
  ctx.out("");
  ctx.out("  This token is shown once and is not recoverable. The previous one stopped");
  ctx.out("  working the moment this command returned.");
  // Which file, if any, the daemon rewrote is the daemon's to report. Guessing
  // it from the device id here would be wrong the moment OMPD_URL points at
  // another machine, where the local token file belongs to a different daemon.
  if (typeof response.tokenPath === "string") {
    ctx.out(`  The daemon rewrote ${response.tokenPath}, so the CLI there needs nothing further.`);
  } else {
    ctx.out("  Hand it to that device; it will not reconnect until you do.");
  }
  return 0;
}
