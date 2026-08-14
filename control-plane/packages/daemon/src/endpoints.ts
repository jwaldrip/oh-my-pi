/**
 * Where this daemon can actually be reached, computed from its own config.
 *
 * `ompd approve` used to hand a device a bare token and let it guess a URL,
 * and the guess was always `ws://127.0.0.1:7777/v1/socket`, which only ever
 * works from the machine that already has the daemon. A phone pairing over
 * the internet needs to be told the truth about what is reachable from where,
 * not handed the one address that is guaranteed to be wrong for it.
 *
 * `reachableEndpoints` is pure: everything it needs (the bound host and port,
 * the hub URL, whether an identity exists to dial that hub as) is passed in,
 * and the one impure lookup, the machine's network interfaces, is a seam so
 * tests never depend on this machine's real addresses.
 */

import { networkInterfaces } from "node:os";
import type { EndpointOffer } from "@ompd/core";

/** The slice of `node:os`'s `NetworkInterfaceInfo` this module actually reads. */
export interface NetworkAddress {
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export interface ReachableEndpointsInput {
  host: string;
  port: number;
  /** Empty string means "no hub configured", matching `OmpdConfig.hubUrl`. */
  hubUrl: string;
  /** Present only when a tunnel identity exists on disk; absent means no hub offer, even with `hubUrl` set. */
  daemonId?: string;
  /** Defaults to the real machine. Tests MUST supply this instead. */
  interfaces?: () => NetworkAddress[];
}

/** Host values that mean "this machine only", in whatever form an operator or default might write them. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

/**
 * Host values that mean "every interface", split by family.
 *
 * The split is load-bearing rather than tidy. `0.0.0.0` accepts IPv4 on every
 * interface, so enumerating this machine's IPv4 addresses describes exactly
 * what it answers. `::` accepts IPv6, and whether it also answers IPv4 through
 * v4-mapped addresses is a platform default this daemon does not probe, so it
 * offers no IPv4 address rather than one it has not established works.
 */
const WILDCARD_V4_HOSTS: Record<string, true> = { "0.0.0.0": true };
const WILDCARD_V6_HOSTS: Record<string, true> = { "::": true };

function defaultInterfaces(): NetworkAddress[] {
  const found: NetworkAddress[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) found.push({ address: entry.address, family: entry.family, internal: entry.internal });
  }
  return found;
}

/**
 * Why the loopback offer is there, and what to do when it is the only one.
 *
 * The sentence changes with the bind because the way out changes with it: a
 * loopback bind needs a different `host`, while an IPv6 wildcard is already
 * reachable and merely has no IPv4 address this daemon will vouch for.
 */
function loopbackNote(boundToLoopback: boolean, wildcardV6: boolean): string {
  const opening =
    "Loopback: a phone cannot use this, because loopback on a device always means that device, never this one. ";
  if (boundToLoopback) {
    return `${opening}This daemon is bound to loopback only, so there is no other way in yet. Set the \`host\` config key to a real address to make it reachable from the same network.`;
  }
  if (wildcardV6) {
    return `${opening}This daemon is bound to the IPv6 wildcard, so whether it answers IPv4 at all depends on the platform and is not something it will claim. Set \`host\` to 0.0.0.0 to be offered this machine's IPv4 addresses.`;
  }
  return `${opening}Use one of the same-network addresses below from another device on this network.`;
}

/** IPv6 literals need brackets in a URL authority; IPv4 never does. */
function socketUrl(address: string, port: number, family: "IPv4" | "IPv6"): string {
  const authority = family === "IPv6" ? `[${address}]` : address;
  return `ws://${authority}:${port}/v1/socket`;
}

/**
 * Every way a device could reach this daemon right now, ranked from most to
 * least restrictive so a client can offer the tightest one that will work.
 */
export function reachableEndpoints(input: ReachableEndpointsInput): EndpointOffer[] {
  const { host, port, hubUrl, daemonId } = input;
  const listInterfaces = input.interfaces ?? defaultInterfaces;
  const boundToLoopback = host in LOOPBACK_HOSTS;
  const wildcardV4 = host in WILDCARD_V4_HOSTS;
  const wildcardV6 = host in WILDCARD_V6_HOSTS;
  const offers: EndpointOffer[] = [];

  // Loopback is only an answer when the socket actually accepts there. A
  // daemon bound to one specific LAN address refuses a connection to
  // 127.0.0.1, so offering it would be a URL that fails on the very machine
  // the operator is typing on.
  if (boundToLoopback || wildcardV4 || wildcardV6) {
    // An IPv6 bind, literal or wildcard, is reached at `::1`. Naming
    // `127.0.0.1` for one would assume the dual-stack default this daemon
    // deliberately does not assume anywhere else.
    const loopbackFamily: "IPv4" | "IPv6" = host === "::1" || wildcardV6 ? "IPv6" : "IPv4";
    const loopbackAddress = loopbackFamily === "IPv6" ? "::1" : "127.0.0.1";
    offers.push({
      endpoint: { transport: "direct", url: socketUrl(loopbackAddress, port, loopbackFamily) },
      reach: "same-machine",
      note: loopbackNote(boundToLoopback, wildcardV6),
    });
  }

  // What a specific bind accepts is exactly that address. Enumerating every
  // interface here would advertise a VPN or a second NIC the socket is not
  // listening on, and each of those URLs fails to connect for a reason the
  // operator cannot see. Only the IPv4 wildcard answers on all of them.
  if (!boundToLoopback && !wildcardV4 && !wildcardV6) {
    offers.push({
      endpoint: { transport: "direct", url: socketUrl(host, port, host.includes(":") ? "IPv6" : "IPv4") },
      reach: "same-network",
      note: `Reaches this daemon from any device that can route to ${host}, which is the one address it is bound to.`,
    });
  } else if (wildcardV4) {
    // Only IPv4 is enumerated, and not because IPv6 is unsupported: a LAN
    // interface's IPv6 address is almost always link-local (fe80::/10), which
    // needs a zone id to mean anything off the interface it was read from. A
    // global IPv6 address is rare enough on a home network that this daemon
    // does not try to detect one, and a bind to `0.0.0.0` would not accept it
    // regardless.
    for (const addr of listInterfaces()) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // A self-assigned 169.254 address is what an interface has when DHCP
      // never answered. It is reported exactly like a real LAN address and is
      // reachable from nothing, so offering it sends an operator to type a
      // long number that cannot work.
      if (addr.address.startsWith("169.254.")) continue;
      offers.push({
        endpoint: { transport: "direct", url: socketUrl(addr.address, port, "IPv4") },
        reach: "same-network",
        note: `Reaches this daemon from any device on the same network as ${addr.address}.`,
      });
    }
  }

  if (hubUrl !== "" && daemonId !== undefined) {
    offers.push({
      endpoint: { transport: "hub", hubUrl, daemonId },
      reach: "anywhere",
      note: `Routes through ${hubUrl}. Works from any network, including cellular, as long as this daemon keeps its outbound connection to the hub open.`,
    });
  }

  return offers;
}
