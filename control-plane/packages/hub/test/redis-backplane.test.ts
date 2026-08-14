/**
 * The backplane Cloud Run actually runs on, against a real Redis.
 *
 * Skipped unless `OMPD_TEST_REDIS_URL` names one, because a test that quietly
 * passes without the dependency it is testing is worse than no test. Start one
 * with `docker run --rm -p 6379:6379 redis:7-alpine` and set the variable.
 *
 * What is worth proving here is the part a memory implementation cannot: that
 * two processes agree about where a daemon is, that a lease actually expires,
 * and that compare-and-set stops a stale instance from evicting the live one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateIdentity, TunnelDaemon } from "@ompd/tunnel";
import type { RelayEnvelope } from "../src/backplane.ts";
import { RecordingAudit } from "../src/audit.ts";
import { Hub } from "../src/hub.ts";
import { RedisBackplane } from "../src/redis-backplane.ts";
import { MemoryRegistry } from "../src/registry.ts";
import { browserTransport, connectThroughHub, until } from "./harness.ts";

const url = process.env.OMPD_TEST_REDIS_URL;
const describeRedis = url === undefined ? describe.skip : describe;

const backplanes: RedisBackplane[] = [];
const hubs: Hub[] = [];
const daemons: TunnelDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.stop();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const backplane of backplanes.splice(0)) await backplane.close();
});

async function backplane(instanceId: string): Promise<RedisBackplane> {
  const created = await RedisBackplane.connect({ url: url ?? "", instanceId: `${instanceId}-${crypto.randomUUID()}` });
  backplanes.push(created);
  return created;
}

describeRedis("redis backplane", () => {
  test("presence is visible from another instance", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    expect(await b.locateDaemon(daemonId)).toBeNull();
    await a.claimDaemon(daemonId, 5_000);
    expect(await b.locateDaemon(daemonId)).toBe(a.instanceId);
  });

  test("a lease expires on its own, so a dead instance stops being an address", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    // Short on purpose: the property is that nothing has to clean up after an
    // instance that was killed without running any shutdown code.
    await a.claimDaemon(daemonId, 150);
    expect(await b.locateDaemon(daemonId)).toBe(a.instanceId);
    await until(async () => (await b.locateDaemon(daemonId)) === null, "the lease to lapse");
  });

  test("renew only extends a lease this instance still holds", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    await a.claimDaemon(daemonId, 5_000);
    expect(await a.renewDaemon(daemonId, 5_000)).toBe(true);

    // The daemon reconnects to B, which takes the lease over. A must not be
    // able to renew or release it now: doing either would make the daemon
    // unroutable while looking perfectly healthy.
    await b.claimDaemon(daemonId, 5_000);
    expect(await a.renewDaemon(daemonId, 5_000)).toBe(false);
    await a.releaseDaemon(daemonId);
    expect(await b.locateDaemon(daemonId)).toBe(b.instanceId);
  });

  test("envelopes reach the addressed instance and nobody else", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const c = await backplane("c");

    const atB: RelayEnvelope[] = [];
    const atC: RelayEnvelope[] = [];
    b.onEnvelope((envelope) => atB.push(envelope));
    c.onEnvelope((envelope) => atC.push(envelope));

    await a.send(b.instanceId, { k: "open", sessionId: "s1", from: a.instanceId, daemonId: "dmn_x" });
    await until(() => atB.length === 1, "the envelope to arrive at B");
    expect(atB[0]?.sessionId).toBe("s1");
    expect(atC).toEqual([]);
  });

  test("a client on one instance reaches a daemon held by another, over redis", async () => {
    const registry = new MemoryRegistry();
    const identity = generateIdentity();
    await registry.enroll({ publicKey: identity.publicKey, label: "alpha" });

    const hubA = new Hub({
      registry,
      backplane: await backplane("hub-a"),
      host: "127.0.0.1",
      port: 0,
      audit: new RecordingAudit().record,
    });
    const hubB = new Hub({
      registry,
      backplane: await backplane("hub-b"),
      host: "127.0.0.1",
      port: 0,
      audit: new RecordingAudit().record,
    });
    hubs.push(hubA, hubB);
    const portA = await hubA.listen();
    const portB = await hubB.listen();

    const daemon = new TunnelDaemon({
      hubUrl: `ws://127.0.0.1:${portA}`,
      identity,
      transport: browserTransport,
      acceptor: {
        accept: (token, send) =>
          token === "token-a"
            ? { ok: true, deviceId: "dev_a", deliver: (raw) => send(`echoed:${raw}`), close: () => {} }
            : { ok: false, reason: "unknown" },
      },
    });
    daemons.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the daemon to register with hub A");

    const got: string[] = [];
    let opened = false;
    const socket = connectThroughHub({
      hubUrl: `ws://127.0.0.1:${portB}`,
      daemonId: identity.daemonId,
      token: "token-a",
      transport: browserTransport,
    });
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (data) => got.push(data);
    await until(() => opened, "a session across two hub processes");

    socket.send("ping");
    await until(() => got.length === 1, "the answer back across redis");
    expect(got[0]).toBe("echoed:ping");
    socket.close();
  });
});
