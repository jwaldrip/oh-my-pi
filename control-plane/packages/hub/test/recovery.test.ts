/**
 * Recovery, through the real relay.
 *
 * A sleeping laptop, a phone changing networks, and a recycling hub instance
 * are all normal here, and Cloud Run guarantees the last one: it terminates any
 * request at sixty minutes, websockets included. So the question is never
 * whether a connection drops, only whether a turn survives it.
 *
 * The daemon in these tests keeps an update log and honours `attach{sinceSeq}`,
 * which is what the real gateway does. That makes the assertions about exact
 * sequences rather than counts: "it recovered" has to mean "it received the
 * frames it missed and not one it already had", or a test passes on luck.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AcceptResult, type SessionAcceptor, TunnelDaemon, type TunnelSocketLike } from "@ompd/tunnel";
import { browserTransport, connectThroughHub, enroll, type FleetFixture, startHubs, until } from "./harness.ts";

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
 * A daemon that streams a turn and can replay it.
 *
 * Deliberately the same shape as the real gateway: updates are appended to a
 * log whether or not anyone is attached, `attach{sinceSeq}` replays from it,
 * and replay and the live stream share one choke point with a per-session
 * high-water mark, so a frame is never delivered twice. Without the log there
 * is nothing for a reconnect to recover from; without the choke point a
 * reconnect double-delivers, and both are properties under test.
 */
class FakeAgent {
  readonly log: Array<{ seq: number; text: string }> = [];
  readonly #sinks = new Set<{ send: (raw: string) => void; delivered: number }>();

  emit(text: string): number {
    const seq = this.log.length + 1;
    this.log.push({ seq, text });
    for (const sink of this.#sinks) this.#deliver(sink, seq, text);
    return seq;
  }

  #deliver(sink: { send: (raw: string) => void; delivered: number }, seq: number, text: string): void {
    if (seq <= sink.delivered) return;
    sink.delivered = seq;
    sink.send(JSON.stringify({ t: "update", seq, text }));
  }

  acceptor(tokens: Record<string, string>): SessionAcceptor {
    return {
      accept: (token, send): AcceptResult => {
        const deviceId = tokens[token];
        if (deviceId === undefined) return { ok: false, reason: "unknown" };
        const sink = { send, delivered: 0 };
        this.#sinks.add(sink);
        return {
          ok: true,
          deviceId,
          deliver: (raw) => {
            const frame = JSON.parse(raw) as { t?: string; sinceSeq?: number };
            if (frame.t !== "attach") return;
            const since = frame.sinceSeq ?? 0;
            // Replay never rewinds the high-water mark, exactly as the real
            // gateway's `#deliverUpdate` does not: an attach that arrived after
            // some frames had already streamed live must not send them twice.
            for (const entry of this.log) {
              if (entry.seq > since) this.#deliver(sink, entry.seq, entry.text);
            }
          },
          close: () => this.#sinks.delete(sink),
        };
      },
    };
  }
}

interface Client {
  socket: TunnelSocketLike;
  seqs: number[];
  opened: boolean;
  closed: boolean;
}

/** Open a client that tracks its own high-water mark, as the real one does. */
function openClient(hubUrl: string, daemonId: string, token: string): Client {
  const state: Client = {
    socket: connectThroughHub({ hubUrl, daemonId, token, transport: browserTransport }),
    seqs: [],
    opened: false,
    closed: false,
  };
  openSockets.push(state.socket);
  state.socket.onopen = () => {
    state.opened = true;
  };
  state.socket.onmessage = (data) => {
    const frame = JSON.parse(data) as { t?: string; seq?: number };
    if (frame.t === "update" && typeof frame.seq === "number") state.seqs.push(frame.seq);
  };
  state.socket.onclose = () => {
    state.closed = true;
  };
  return state;
}

describe("a dropped connection loses no part of a turn", () => {
  test("the daemon leg drops mid-turn and the client resumes with sinceSeq", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const agent = new FakeAgent();
    const identity = await enroll(fleet, "alpha");

    const spawn = (): TunnelDaemon => {
      const daemon = new TunnelDaemon({
        hubUrl: url,
        identity,
        acceptor: agent.acceptor({ "token-a": "dev_a" }),
        transport: browserTransport,
        minBackoffMs: 5,
        maxBackoffMs: 10,
      });
      running.push(daemon);
      daemon.start();
      return daemon;
    };

    const daemon = spawn();
    await until(() => daemon.registered, "the daemon to register");

    const client = openClient(url, identity.daemonId, "token-a");
    await until(() => client.opened, "the session to open");
    client.socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 0 }));

    agent.emit("one");
    agent.emit("two");
    await until(() => client.seqs.length === 2, "the first two updates");

    // The laptop sleeps. The daemon's leg dies and takes the session with it.
    daemon.stop();
    await until(() => client.closed, "the client to be told its peer went away");

    // The turn keeps going at the daemon. Execution is not the tunnel's
    // business, so a dead tunnel must not stop it.
    agent.emit("three");
    agent.emit("four");

    // The laptop wakes and dials out again.
    const revived = spawn();
    await until(() => revived.registered, "the daemon to re-register");

    // The phone reconnects and asks for what it missed, by number.
    const resumed = openClient(url, identity.daemonId, "token-a");
    await until(() => resumed.opened, "the resumed session to open");
    resumed.socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 2 }));
    await until(() => resumed.seqs.length === 2, "the missed updates");

    // Exactly the frames it missed, and not one it already had.
    expect(client.seqs).toEqual([1, 2]);
    expect(resumed.seqs).toEqual([3, 4]);
  });

  test("the client leg drops mid-turn and reconnects with sinceSeq", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const agent = new FakeAgent();
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity,
      acceptor: agent.acceptor({ "token-a": "dev_a" }),
      transport: browserTransport,
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the daemon to register");

    const client = openClient(url, identity.daemonId, "token-a");
    await until(() => client.opened, "the session to open");
    client.socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 0 }));
    agent.emit("one");
    await until(() => client.seqs.length === 1, "the first update");

    // The phone changes networks. Its socket dies; the daemon does not.
    client.socket.close();
    await until(() => daemon.sessionCount === 0, "the daemon to drop the dead session");

    agent.emit("two");
    agent.emit("three");

    const resumed = openClient(url, identity.daemonId, "token-a");
    await until(() => resumed.opened, "the resumed session to open");
    resumed.socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 1 }));
    await until(() => resumed.seqs.length === 2, "the missed updates");

    expect(client.seqs).toEqual([1]);
    expect(resumed.seqs).toEqual([2, 3]);
    // The daemon stayed up throughout, so this really was a client-side drop.
    expect(daemon.registered).toBe(true);
  });

  test("a daemon reconnecting to a different hub instance stays reachable", async () => {
    fleet = await startHubs(2);
    const a = fleet.hubs[0]?.url ?? "";
    const b = fleet.hubs[1]?.url ?? "";
    const agent = new FakeAgent();
    const identity = await enroll(fleet, "alpha");

    const first = new TunnelDaemon({
      hubUrl: a,
      identity,
      acceptor: agent.acceptor({ "token-a": "dev_a" }),
      transport: browserTransport,
    });
    running.push(first);
    first.start();
    await until(() => first.registered, "the daemon to register with A");
    agent.emit("one");

    // The instance holding this daemon recycles, which on Cloud Run is routine.
    // The daemon comes back on a different one.
    first.stop();
    const second = new TunnelDaemon({
      hubUrl: b,
      identity,
      acceptor: agent.acceptor({ "token-a": "dev_a" }),
      transport: browserTransport,
    });
    running.push(second);
    second.start();
    await until(() => second.registered, "the daemon to register with B");
    agent.emit("two");

    // A client arriving at the instance that no longer holds the daemon still
    // finds it, because presence is in the shared routing table rather than in
    // either process.
    const client = openClient(a, identity.daemonId, "token-a");
    await until(() => client.opened, "a session via the other instance");
    client.socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 0 }));
    await until(() => client.seqs.length === 2, "the whole turn replayed");
    expect(client.seqs).toEqual([1, 2]);
  });

  test("a relayed frame that goes missing tears the session down rather than hiding it", async () => {
    fleet = await startHubs(1);
    const url = fleet.hubs[0]?.url ?? "";
    const agent = new FakeAgent();
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: url,
      identity,
      acceptor: agent.acceptor({ "token-a": "dev_a" }),
      transport: browserTransport,
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the daemon to register");

    // A transport that swallows one inbound session frame, which is exactly
    // what a relay losing a frame looks like from the client's side. The
    // handshake is left alone so the session gets far enough to matter.
    let dropNext = false;
    const lossy = (target: string): TunnelSocketLike => {
      const inner = browserTransport(target);
      let downstream: ((data: string) => void) | null = null;
      inner.onmessage = (data) => {
        const frame = JSON.parse(data) as { t?: string };
        if (dropNext && frame.t === "data") {
          dropNext = false;
          return;
        }
        downstream?.(data);
      };
      return new Proxy(inner, {
        get: (target2, key) => (key === "onmessage" ? downstream : Reflect.get(target2, key)),
        set: (target2, key, value) => {
          if (key === "onmessage") {
            downstream = value as (data: string) => void;
            return true;
          }
          return Reflect.set(target2, key, value);
        },
      });
    };

    const seqs: number[] = [];
    let opened = false;
    let closed = false;
    const socket = connectThroughHub({
      hubUrl: url,
      daemonId: identity.daemonId,
      token: "token-a",
      transport: lossy,
    });
    openSockets.push(socket);
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (data) => {
      const frame = JSON.parse(data) as { t?: string; seq?: number };
      if (frame.t === "update" && typeof frame.seq === "number") seqs.push(frame.seq);
    };
    socket.onclose = () => {
      closed = true;
    };
    await until(() => opened, "the session to open");

    socket.send(JSON.stringify({ t: "attach", agentId: "agt", sinceSeq: 0 }));
    agent.emit("one");
    await until(() => seqs.length === 1, "the first update");

    // Lose the next one, then send another behind it.
    dropNext = true;
    agent.emit("two");
    agent.emit("three");

    // A gap is not something to resynchronise past: the client cannot know
    // what was in the hole, so the session ends and it resumes from the log
    // rather than silently showing a transcript with a piece missing.
    await until(() => closed, "the session to end rather than stall");
    expect(seqs).toEqual([1]);
  });
});
