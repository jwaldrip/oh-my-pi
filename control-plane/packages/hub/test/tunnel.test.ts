/**
 * End to end, over real websockets, against a real relay.
 *
 * The daemon side here is the real `TunnelDaemon` with a stand-in acceptor, so
 * every frame goes through the real handshake, the real sealed channel, and the
 * real hub. Only the credential decision is stubbed, and the daemon package has
 * its own test proving that seam reaches the gateway's shared scope checks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AcceptResult,
  connectThroughHub,
  generateIdentity,
  type SessionAcceptor,
  type SessionEvent,
  TunnelDaemon,
  type TunnelSocketLike,
} from "@ompd/tunnel";
import { browserTransport, enroll, type FleetFixture, httpUrl, OPERATOR_TOKEN, startHubs, until } from "./harness.ts";

let fleet: FleetFixture | null = null;
const running: TunnelDaemon[] = [];
const openSockets: TunnelSocketLike[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  for (const daemon of running.splice(0)) daemon.stop();
  await fleet?.stop();
  fleet = null;
});

/**
 * An acceptor that echoes whatever it is given, tagged with the daemon's name.
 *
 * Enough to prove a frame reached a specific daemon and came back, which is
 * what "end to end" has to mean here.
 */
function echoAcceptor(name: string, tokens: Record<string, string | "revoked">): SessionAcceptor {
  return {
    accept(token, send): AcceptResult {
      const found = tokens[token];
      if (found === undefined) return { ok: false, reason: "unknown" };
      if (found === "revoked") return { ok: false, reason: "revoked" };
      return {
        ok: true,
        deviceId: found,
        deliver: (raw) => send(JSON.stringify({ from: name, echo: JSON.parse(raw) })),
        close: () => {},
      };
    },
  };
}

interface Wired {
  daemon: TunnelDaemon;
  identity: Awaited<ReturnType<typeof enroll>>;
}

async function startDaemon(hubUrl: string, name: string, tokens: Record<string, string | "revoked">): Promise<Wired> {
  if (!fleet) throw new Error("fleet not started");
  const identity = await enroll(fleet, name);
  const daemon = new TunnelDaemon({
    hubUrl,
    identity,
    acceptor: echoAcceptor(name, tokens),
    transport: browserTransport,
  });
  running.push(daemon);
  daemon.start();
  await until(() => daemon.registered, `${name} to register`);
  return { daemon, identity };
}

/** Open a client and collect what it receives. */
function openClient(hubUrl: string, daemonId: string, token: string) {
  const received: string[] = [];
  const errors: string[] = [];
  let opened = false;
  let closed: { code: number; reason: string } | null = null;

  const socket = connectThroughHub({ hubUrl, daemonId, token, transport: browserTransport });
  openSockets.push(socket);
  socket.onopen = () => {
    opened = true;
  };
  socket.onmessage = (data) => received.push(data);
  socket.onerror = (info) => errors.push(info.message);
  socket.onclose = (info) => {
    closed = info;
  };
  return {
    socket,
    received,
    errors,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}

describe("through the hub", () => {
  test("a client reaches its daemon, with two daemons registered", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const alpha = await startDaemon(url, "alpha", { "token-a": "dev_a" });
    const beta = await startDaemon(url, "beta", { "token-b": "dev_b" });
    expect(alpha.identity.daemonId).not.toBe(beta.identity.daemonId);

    const client = openClient(url, alpha.identity.daemonId, "token-a");
    await until(() => client.opened, "the session to open");

    client.socket.send(JSON.stringify({ t: "prompt", text: "hello alpha" }));
    await until(() => client.received.length > 0, "an answer");

    // Reached alpha specifically, not whichever daemon the hub felt like.
    expect(JSON.parse(client.received[0] ?? "{}")).toEqual({
      from: "alpha",
      echo: { t: "prompt", text: "hello alpha" },
    });

    const toBeta = openClient(url, beta.identity.daemonId, "token-b");
    await until(() => toBeta.opened, "the second session to open");
    toBeta.socket.send(JSON.stringify({ t: "prompt", text: "hello beta" }));
    await until(() => toBeta.received.length > 0, "an answer from beta");
    expect(JSON.parse(toBeta.received[0] ?? "{}").from).toBe("beta");
  });

  test("a public webhook reaches only the pinned daemon and preserves its body", async () => {
    fleet = await startHubs(2);
    const daemonUrl = fleet.hubs[0]?.url ?? "";
    const publicUrl = fleet.hubs[1]?.url ?? "";
    const identity = await enroll(fleet, "webhook-daemon");
    const received: Array<{ routineId: string; secret: string; body: string; contentType?: string }> = [];
    const daemon = new TunnelDaemon({
      hubUrl: daemonUrl,
      identity,
      acceptor: echoAcceptor("webhook-daemon", {}),
      transport: browserTransport,
      onWebhook: async (request) => {
        received.push(request);
        return {
          status: 202,
          body: Buffer.from(JSON.stringify({ run: { id: "run_webhook" } })).toString("base64url"),
          contentType: "application/json",
        };
      },
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "webhook daemon to register");

    const response = await fetch(
      `${httpUrl(publicUrl)}/v1/webhooks/${identity.daemonId}/rtn_webhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": "per-routine-secret" },
        body: JSON.stringify({ event: "pushed" }),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run: { id: "run_webhook" } });
    expect(received).toHaveLength(1);
    const delivery = received[0];
    if (delivery === undefined) throw new Error("webhook request was not delivered");
    expect(delivery.routineId).toBe("rtn_webhook");
    expect(delivery.secret).toBe("per-routine-secret");
    expect(delivery.body).toBe(Buffer.from(JSON.stringify({ event: "pushed" })).toString("base64url"));
    expect(delivery.contentType).toBe("application/json");
  });

  test("a client paired to daemon A cannot reach daemon B", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const alpha = await startDaemon(url, "alpha", { "token-a": "dev_a" });
    await startDaemon(url, "beta", { "token-b": "dev_b" });

    // A's credential, aimed at B. B has never heard of it.
    const client = openClient(url, (await currentDaemonId(fleet, "beta")) ?? "", "token-a");
    await until(() => client.closed !== null, "the session to be refused");
    expect(client.opened).toBe(false);

    // And the same token still works against the daemon it belongs to, so the
    // refusal was about the target rather than the token being broken.
    const ok = openClient(url, alpha.identity.daemonId, "token-a");
    await until(() => ok.opened, "the rightful session to open");
    expect(ok.opened).toBe(true);
  });

  test("the hub never sees the bearer token", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const alpha = await startDaemon(url, "alpha", { "sup3r-s3cret-token": "dev_a" });

    const seen: string[] = [];
    const spyTransport = (target: string): TunnelSocketLike => {
      seen.push(target);
      const inner = browserTransport(target);
      return {
        get readyState() {
          return inner.readyState;
        },
        set readyState(value: number) {
          inner.readyState = value;
        },
        send: (data) => {
          seen.push(data);
          inner.send(data);
        },
        close: (code, reason) => inner.close(code, reason),
        get onopen() {
          return inner.onopen;
        },
        set onopen(fn) {
          inner.onopen = fn;
        },
        get onclose() {
          return inner.onclose;
        },
        set onclose(fn) {
          inner.onclose = fn;
        },
        get onerror() {
          return inner.onerror;
        },
        set onerror(fn) {
          inner.onerror = fn;
        },
        get onmessage() {
          return inner.onmessage;
        },
        set onmessage(fn) {
          inner.onmessage = fn;
        },
      };
    };

    const socket = connectThroughHub({
      hubUrl: url,
      daemonId: alpha.identity.daemonId,
      token: "sup3r-s3cret-token",
      transport: spyTransport,
    });
    openSockets.push(socket);
    const echoed: string[] = [];
    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (data) => echoed.push(data);

    await until(() => opened, "the session to open");
    socket.send(JSON.stringify({ t: "prompt", text: "secret work" }));
    // Wait for the round trip rather than a guessed delay: once the answer is
    // back, everything this client was ever going to write has been written.
    await until(() => echoed.length > 0, "the round trip to finish");

    // Everything the client wrote onto the wire the hub reads, including the
    // URL it opened. The credential appears in none of it.
    const wire = seen.join("\n");
    expect(wire).not.toContain("sup3r-s3cret-token");
    expect(wire).not.toContain("token=");
    expect(wire).not.toContain("secret work");
    // And the handshake did happen over that same wire, so this is not a
    // vacuous pass on an empty transcript.
    expect(wire).toContain("hello");
  });
});

describe("more than one hub instance", () => {
  test("a client on instance B reaches a daemon held by instance A", async () => {
    fleet = await startHubs(2);
    const a = fleet.hubs[0]?.url ?? "";
    const b = fleet.hubs[1]?.url ?? "";
    expect(a).not.toBe(b);

    // Daemon dials instance A only.
    const alpha = await startDaemon(a, "alpha", { "token-a": "dev_a" });
    // Client connects to instance B, which holds no leg for it.
    const client = openClient(b, alpha.identity.daemonId, "token-a");
    await until(() => client.opened, "a cross-instance session to open");

    client.socket.send(JSON.stringify({ t: "prompt", text: "across instances" }));
    await until(() => client.received.length > 0, "a cross-instance answer");
    expect(JSON.parse(client.received[0] ?? "{}")).toEqual({
      from: "alpha",
      echo: { t: "prompt", text: "across instances" },
    });
  });

  test("losing the routing connection tears sessions down rather than hanging", async () => {
    fleet = await startHubs(2);
    const a = fleet.hubs[0]?.url ?? "";
    const b = fleet.hubs[1]?.url ?? "";
    const alpha = await startDaemon(a, "alpha", { "token-a": "dev_a" });
    const client = openClient(b, alpha.identity.daemonId, "token-a");
    await until(() => client.opened, "a cross-instance session to open");

    // The instance holding the client leg loses its backplane connection. Its
    // websockets are still up, so without this signal the client would sit
    // waiting on a stream that can no longer be fed.
    fleet.hubs[1]?.backplane.disrupt("subscriber closed");
    await until(() => client.closed !== null, "the client to be told");

    const torn = fleet.hubs[1]?.audit.forAction("session.torn") ?? [];
    expect(torn.length).toBeGreaterThan(0);
    expect(torn[0]?.code).toBe("relay_broken");
  });
});

describe("refusals", () => {
  test("an unknown daemon is refused and audited", async () => {
    fleet = await startHubs(1);
    const hub = fleet.hubs[0];
    const stranger = generateIdentity();
    const response = await fetch(`${httpUrl(hub?.url ?? "")}/v1/link/${stranger.daemonId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "unknown_daemon" });

    const denied = hub?.audit.forAction("client.link").filter((entry) => entry.outcome === "denied") ?? [];
    expect(denied[0]?.code).toBe("unknown_daemon");
  });

  test("an enrolled but disconnected daemon is refused as offline", async () => {
    fleet = await startHubs(1);
    const hub = fleet.hubs[0];
    const identity = await enroll(fleet, "asleep");
    const response = await fetch(`${httpUrl(hub?.url ?? "")}/v1/link/${identity.daemonId}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "daemon_offline" });
  });

  test("a daemon that is not enrolled cannot register", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const stranger = generateIdentity();
    const refusals: string[] = [];
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity: stranger,
      acceptor: echoAcceptor("stranger", {}),
      transport: browserTransport,
      onRefused: (code) => refusals.push(code),
    });
    running.push(daemon);
    daemon.start();

    await until(() => refusals.length > 0, "the hub to refuse an unenrolled daemon");
    expect(refusals[0]).toBe("unknown_daemon");
    expect(daemon.registered).toBe(false);

    const denied = fleet.hubs[0]?.audit.forAction("daemon.register").filter((e) => e.outcome === "denied") ?? [];
    expect(denied[0]?.code).toBe("unknown_daemon");
  });

  test("a daemon that cannot sign the challenge is refused as unverifiable", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    // Enrolled under the real key, but dialing with a different private half:
    // exactly what an attacker who learned a daemon id but not its key has.
    const real = await enroll(fleet, "real");
    const impostor = generateIdentity();
    const refusals: string[] = [];
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity: { daemonId: real.daemonId, publicKey: real.publicKey, privateKey: impostor.privateKey },
      acceptor: echoAcceptor("impostor", {}),
      transport: browserTransport,
      onRefused: (code) => refusals.push(code),
    });
    running.push(daemon);
    daemon.start();

    await until(() => refusals.length > 0, "the hub to refuse a bad signature");
    expect(refusals[0]).toBe("unverifiable");
  });

  test("an unknown client credential is refused by the daemon, not the hub", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const sessions: SessionEvent[] = [];
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity,
      acceptor: echoAcceptor("alpha", { good: "dev_a" }),
      transport: browserTransport,
      onSession: (event) => sessions.push(event),
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "alpha to register");

    const client = openClient(url, identity.daemonId, "never-issued");
    await until(() => client.closed !== null, "the credential to be refused");
    expect(client.opened).toBe(false);
    // Split rather than one `toEqual` with an asymmetric matcher: the id is
    // minted per session, so the only honest claim about it is that there is
    // one, and the outcome is what this test is actually about.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ outcome: "denied", reason: "unknown" });
    expect(sessions[0]?.sessionId).toBeString();
  });

  test("a revoked credential is refused, and distinguishably so", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const sessions: SessionEvent[] = [];
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity,
      acceptor: echoAcceptor("alpha", { withdrawn: "revoked" }),
      transport: browserTransport,
      onSession: (event) => sessions.push(event),
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "alpha to register");

    const client = openClient(url, identity.daemonId, "withdrawn");
    await until(() => client.closed !== null, "the revoked credential to be refused");
    // Not collapsed into the same answer as an unknown token: an operator
    // needs to tell "never real" from "I withdrew that".
    expect(sessions[0]?.reason).toBe("revoked");
  });

  test("a hub that substitutes a key for a pinned daemon id is caught", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const impostor = generateIdentity();
    // The daemon actually running is the impostor, enrolled under its own id.
    await fleet.registry.enroll({ publicKey: impostor.publicKey, label: "impostor" });
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity: impostor,
      acceptor: echoAcceptor("impostor", { "token-a": "dev_a" }),
      transport: browserTransport,
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the impostor to register");

    // A client that pinned a different id gets the impostor's key from the hub
    // and must refuse it, because it does not hash to what it pinned.
    const victim = generateIdentity();
    const client = openClient(url, victim.daemonId, "token-a");
    await until(() => client.closed !== null, "the client to refuse a substituted key");
    expect(client.opened).toBe(false);
  });

  test("enrollment requires the operator credential", async () => {
    fleet = await startHubs(1);
    const base = httpUrl(fleet.hubs[0]?.url ?? "");
    const identity = generateIdentity();
    const body = JSON.stringify({ publicKey: identity.publicKey, label: "new" });

    const anonymous = await fetch(`${base}/v1/enroll`, { method: "POST", body });
    expect(anonymous.status).toBe(401);

    const wrong = await fetch(`${base}/v1/enroll`, {
      method: "POST",
      body,
      headers: { authorization: "Bearer not-the-operator" },
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${base}/v1/enroll`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(right.status).toBe(200);
    // The hub derives the id from the key rather than believing a caller.
    expect(await right.json()).toMatchObject({ daemonId: identity.daemonId });
  });

  test("a hub that cannot reach its registry refuses rather than admits", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const identity = await enroll(fleet, "alpha");
    // The registry starts failing, which is what a lost database connection
    // looks like from here.
    fleet.registry.lookup = async () => {
      throw new Error("registry unreachable");
    };

    const response = await fetch(`${httpUrl(url)}/v1/link/${identity.daemonId}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "unverifiable" });
  });
});

async function currentDaemonId(fixture: FleetFixture, label: string): Promise<string | null> {
  for (const row of await fixture.registry.list()) if (row.label === label) return row.daemonId;
  return null;
}
