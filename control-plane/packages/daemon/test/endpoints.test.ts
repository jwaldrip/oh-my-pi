/**
 * `reachableEndpoints` is pure, so most of this is table-driven assertions
 * against the seam rather than against this machine's real interfaces.
 * `GET /v1/endpoints` is then just the scope check plus one seam call, which
 * is what the wire-level tests below confirm.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, SCOPE_PROMPT, SCOPE_READ, Store, type EndpointOffer } from "@ompd/core";
import { HostRegistry } from "../src/hosts.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { reachableEndpoints, type NetworkAddress } from "../src/endpoints.ts";
import { Ompd } from "../src/daemon.ts";
import { createFakeHost } from "./fake-host.ts";

const TWO_INTERFACES: NetworkAddress[] = [
  { address: "127.0.0.1", family: "IPv4", internal: true },
  { address: "::1", family: "IPv6", internal: true },
  { address: "10.4.1.221", family: "IPv4", internal: false },
  { address: "192.168.1.9", family: "IPv4", internal: false },
  { address: "fe80::1", family: "IPv6", internal: false },
];

function isDirect(offer: EndpointOffer): offer is EndpointOffer & { endpoint: { transport: "direct"; url: string } } {
  return offer.endpoint.transport === "direct";
}

function directUrls(offers: EndpointOffer[]): string[] {
  return offers.filter(isDirect).map((o) => o.endpoint.url);
}

describe("reachableEndpoints", () => {
  test("loopback-only bind offers loopback and nothing else", () => {
    const offers = reachableEndpoints({
      host: "127.0.0.1",
      port: 7777,
      hubUrl: "",
      interfaces: () => TWO_INTERFACES,
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]?.reach).toBe("same-machine");
    expect(offers[0]?.endpoint).toEqual({ transport: "direct", url: "ws://127.0.0.1:7777/v1/socket" });
    // Names loopback plainly, and, since it is the only offer, also carries
    // the way out: which config key changes the bind.
    expect(offers[0]?.note.toLowerCase()).toContain("loopback");
    expect(offers[0]?.note).toContain("host");
    expect(offers.some((o) => o.reach === "same-network")).toBe(false);
  });

  test("an explicit ::1 bind offers a bracketed IPv6 loopback URL and still no same-network endpoint", () => {
    const offers = reachableEndpoints({
      host: "::1",
      port: 7777,
      hubUrl: "",
      interfaces: () => TWO_INTERFACES,
    });

    expect(offers).toHaveLength(1);
    // Bracketed, and IPv6, because that is the literal family this daemon
    // actually accepted a connection on; the IPv4 loopback used everywhere
    // else would not reach a daemon bound this way.
    expect(offers[0]?.endpoint).toEqual({ transport: "direct", url: "ws://[::1]:7777/v1/socket" });
    expect(offers.some((o) => o.reach === "same-network")).toBe(false);
  });

  test("0.0.0.0 bind with two off-machine interfaces offers loopback plus each non-internal IPv4 address", () => {
    const offers = reachableEndpoints({
      host: "0.0.0.0",
      port: 7777,
      hubUrl: "",
      interfaces: () => TWO_INTERFACES,
    });

    const urls = directUrls(offers);
    expect(urls).toEqual([
      "ws://127.0.0.1:7777/v1/socket",
      "ws://10.4.1.221:7777/v1/socket",
      "ws://192.168.1.9:7777/v1/socket",
    ]);

    const loopback = offers.find((o) => o.reach === "same-machine");
    expect(loopback?.note.toLowerCase()).toContain("loopback");

    const sameNetwork = offers.filter((o) => o.reach === "same-network");
    expect(sameNetwork).toHaveLength(2);
    for (const offer of sameNetwork) expect(offer.endpoint.transport).toBe("direct");

    // Internal addresses (the loopback interface itself, however it is
    // spelled) and every IPv6 address are excluded from the same-network set.
    expect(urls.some((u) => u.includes("::1"))).toBe(false);
    expect(urls.some((u) => u.includes("fe80"))).toBe(false);

    expect(offers.some((o) => o.reach === "anywhere")).toBe(false);
  });

  test("hub configured with an identity offers an anywhere endpoint", () => {
    const offers = reachableEndpoints({
      host: "127.0.0.1",
      port: 7777,
      hubUrl: "wss://hub.example.com",
      daemonId: "daemon_abc123",
      interfaces: () => TWO_INTERFACES,
    });

    const hub = offers.find((o) => o.reach === "anywhere");
    expect(hub?.endpoint).toEqual({
      transport: "hub",
      hubUrl: "wss://hub.example.com",
      daemonId: "daemon_abc123",
    });
  });

  test("hub configured without an identity offers no hub endpoint", () => {
    const offers = reachableEndpoints({
      host: "127.0.0.1",
      port: 7777,
      hubUrl: "wss://hub.example.com",
      interfaces: () => TWO_INTERFACES,
    });

    expect(offers.some((o) => o.reach === "anywhere")).toBe(false);
  });

  test("no hub configured offers no hub endpoint even with an identity", () => {
    const offers = reachableEndpoints({
      host: "127.0.0.1",
      port: 7777,
      hubUrl: "",
      daemonId: "daemon_abc123",
      interfaces: () => TWO_INTERFACES,
    });

    expect(offers.some((o) => o.reach === "anywhere")).toBe(false);
  });

  test("a :: wildcard bind offers IPv6 loopback and refuses to claim any IPv4 address", () => {
    // `::` accepts IPv6 on every interface. Whether it also accepts IPv4
    // through v4-mapped addresses is a platform default, so enumerating this
    // machine's IPv4 addresses here would advertise reachability that was
    // never established. The note has to name the config change that does.
    const offers = reachableEndpoints({
      host: "::",
      port: 7777,
      hubUrl: "",
      interfaces: () => TWO_INTERFACES,
    });

    const loopback = offers.find((o) => o.reach === "same-machine");
    expect(loopback?.endpoint).toEqual({ transport: "direct", url: "ws://[::1]:7777/v1/socket" });
    expect(loopback?.note).toContain("0.0.0.0");

    expect(offers.filter((o) => o.reach === "same-network")).toHaveLength(0);
  });

  test("a bind to one specific address offers that address and nothing else", () => {
    // Two bugs this catches. Treating any non-loopback host as a wildcard and
    // walking every interface, which advertises a VPN or second NIC the
    // socket is not listening on. And offering loopback unconditionally: a
    // socket bound to 192.168.1.9 refuses 127.0.0.1, so that URL fails on the
    // very machine the operator is typing on.
    const offers = reachableEndpoints({
      host: "192.168.1.9",
      port: 7777,
      hubUrl: "",
      interfaces: () => TWO_INTERFACES,
    });

    expect(directUrls(offers)).toEqual(["ws://192.168.1.9:7777/v1/socket"]);
    expect(offers.some((o) => o.reach === "same-machine")).toBe(false);
  });

  test("a self-assigned address is never offered, because it reaches nothing", () => {
    // 169.254 is what an interface holds when DHCP never answered. It is
    // reported exactly like a real LAN address, so nothing but an explicit
    // exclusion keeps it out of the list an operator types from.
    const offers = reachableEndpoints({
      host: "0.0.0.0",
      port: 7777,
      hubUrl: "",
      interfaces: () => [
        { address: "169.254.51.144", family: "IPv4", internal: false },
        { address: "10.4.1.221", family: "IPv4", internal: false },
      ],
    });

    expect(directUrls(offers)).toEqual([
      "ws://127.0.0.1:7777/v1/socket",
      "ws://10.4.1.221:7777/v1/socket",
    ]);
  });
});

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];

interface Harness {
  base: string;
  pair(scopes: string[]): Promise<string>;
  http(path: string, init?: RequestInit, token?: string): Promise<Response>;
}

async function harness(offers: EndpointOffer[]): Promise<Harness> {
  const dbPath = `/tmp/ompd-endpoints-${crypto.randomUUID()}.db`;
  paths.push(dbPath);
  const store = new Store(dbPath);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    endpoints: () => offers,
  });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    pair: async (scopes) => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    http: (routePath, init = {}, token) => {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${base}${routePath}`, { ...init, headers });
    },
  };
}

describe("GET /v1/endpoints", () => {
  test("refuses a token without read scope", async () => {
    const h = await harness([]);
    const token = await h.pair([SCOPE_PROMPT]);
    const res = await h.http("/v1/endpoints", {}, token);
    expect(res.status).toBe(403);
  });

  test("returns the seam's offers for a token with read scope", async () => {
    const offer: EndpointOffer = {
      endpoint: { transport: "direct", url: "ws://192.168.1.9:7777/v1/socket" },
      reach: "same-network",
      note: "Reaches this daemon from any device on the same network as 192.168.1.9.",
    };
    const h = await harness([offer]);
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/endpoints", {}, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offers: EndpointOffer[] };
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]?.reach).toBe("same-network");
    expect(body.offers.some((o) => o.reach === "same-network")).toBe(true);
  });

  test("reports an empty offer list, not an error, when no endpoints seam is wired in", async () => {
    const dbPath = `/tmp/ompd-endpoints-nowire-${crypto.randomUUID()}.db`;
    paths.push(dbPath);
    const store = new Store(dbPath);
    stores.push(store);
    const fake = createFakeHost();
    const events = new GatewayEvents();
    const hosts = new HostRegistry({ spawn: fake.factory });
    const sup = new Supervisor({
      store,
      policy: new DefaultPolicy({ mode: "standard" }),
      spawnHost: hosts.spawn,
      events,
    });
    const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts });
    gateways.push(gw);
    const port = await gw.listen();
    const base = `http://127.0.0.1:${port}`;

    const pairRes = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
    });
    const pairBody = (await pairRes.json()) as { code: string };
    const token = gw.approvePairing(pairBody.code, [SCOPE_READ]);

    const res = await fetch(`${base}/v1/endpoints`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offers: [] });
  });
});

describe("GET /v1/endpoints against a real Ompd", () => {
  const scratchDirs: string[] = [];
  const daemons: Ompd[] = [];

  test("names the port the gateway actually bound, never the configured 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "ompd-endpoints-daemon-"));
    scratchDirs.push(home);
    const daemon = new Ompd({
      home,
      // The default a real operator gets: ask the OS for a free port. The
      // whole point of this test is that the seam must not echo this `0`
      // back into an offer.
      overrides: { port: 0 },
      spawnHost: createFakeHost().factory,
      voice: false,
    });
    daemons.push(daemon);

    const info = await daemon.start();
    expect(info.port).toBeGreaterThan(0);

    const token = (await Bun.file(join(home, "token")).text()).trim();
    const res = await fetch(`${info.url}/v1/endpoints`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offers: EndpointOffer[] };

    const loopback = body.offers.find((o) => o.reach === "same-machine");
    expect(loopback?.endpoint).toEqual({ transport: "direct", url: `ws://127.0.0.1:${info.port}/v1/socket` });
    for (const offer of body.offers.filter(isDirect)) expect(offer.endpoint.url).not.toContain(":0/");
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
});

afterEach(async () => {
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});
