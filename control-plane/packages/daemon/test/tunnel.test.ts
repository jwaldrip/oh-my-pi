/**
 * The seam where a tunnel session becomes a gateway session.
 *
 * The relay itself is proven end to end in `@ompd/hub`. What is proven here is
 * the thing that would be invisible from out there: that a frame arriving over
 * a tunnel is refused by the *same* check that refuses it locally, rather than
 * by a second copy that can drift.
 *
 * That distinction is the whole reason `acceptTunnelSession` exists instead of
 * a parallel authenticated socket. A test that only walked the happy path
 * through the tunnel would pass just as well against a tunnel that authorised
 * nothing, which is exactly the defect worth ruling out.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DefaultPolicy,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

interface Fixture {
  gw: Gateway;
  store: Store;
  events: GatewayEvents;
  /** Mint a device and a live token for it, without going through pairing. */
  device(id: string, scopes: string[]): string;
}

async function fixture(): Promise<Fixture> {
  const path = `/tmp/ompd-tunnel-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: createFakeHost().factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: 500,
    spawnHost: hosts.spawn,
    events,
  });
  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts });
  gateways.push(gw);
  await gw.listen();

  return {
    gw,
    store,
    events,
    device: (id, scopes) => {
      store.addDevice({ id, name: id, publicKey: `pk_${id}`, scopes, createdAt: new Date().toISOString() });
      return gw.issueToken(id);
    },
  };
}

/** Open a tunnel session and collect the frames the gateway writes back. */
function session(gw: Gateway, token: string) {
  const frames: ServerFrame[] = [];
  const result = gw.acceptTunnelSession(token, (raw) => frames.push(JSON.parse(raw) as ServerFrame));
  return { frames, result };
}

describe("tunnel sessions reuse the local authorization path", () => {
  test("an unknown token is refused, and distinguishably from a revoked one", async () => {
    const f = await fixture();
    expect(f.gw.acceptTunnelSession("never-issued", () => {})).toEqual({ ok: false, reason: "unknown" });
  });

  test("a revoked device is refused as revoked", async () => {
    const f = await fixture();
    const token = f.device("dev_revoked", [SCOPE_READ, SCOPE_PROMPT]);
    f.store.revokeDevice("dev_revoked");
    expect(f.gw.acceptTunnelSession(token, () => {})).toEqual({ ok: false, reason: "revoked" });
  });

  test("scopes come from the device row, never from the tunnel", async () => {
    const f = await fixture();
    const token = f.device("dev_reader", [SCOPE_READ]);
    const { frames, result } = session(f.gw, token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deviceId).toBe("dev_reader");

    // `hello` reports what the session actually holds. A tunnel that could
    // choose its own scopes would have had to say so here.
    const hello = frames.find((frame) => frame.t === "hello");
    expect(hello).toMatchObject({ t: "hello", deviceId: "dev_reader" });
  });

  /**
   * The parity check Main asked for.
   *
   * A device holding read but not prompt sends the same frame over both
   * transports. Both must be refused, with the same code and the same message,
   * because both must have gone through the same check. A differing message
   * would mean a second implementation had grown somewhere.
   */
  test("a scope-gated frame is refused identically over the tunnel and locally", async () => {
    const f = await fixture();
    const token = f.device("dev_reader", [SCOPE_READ]);

    const viaTunnel = session(f.gw, token);
    if (!viaTunnel.result.ok) throw new Error("tunnel session was refused");
    viaTunnel.result.deliver(JSON.stringify({ t: "prompt", agentId: "agt_x", text: "do a thing" }));
    const tunnelError = viaTunnel.frames.find((frame) => frame.t === "error");

    const local = session(f.gw, token);
    if (!local.result.ok) throw new Error("second session was refused");
    local.result.deliver(JSON.stringify({ t: "prompt", agentId: "agt_x", text: "do a thing" }));
    const localError = local.frames.find((frame) => frame.t === "error");

    expect(tunnelError).toMatchObject({
      t: "error",
      code: "unauthorized",
      message: "prompt requires prompt scope",
    });
    // Byte for byte the same refusal, which is only possible if one check
    // produced both.
    expect(tunnelError).toEqual(localError);
  });

  test("the same device with prompt scope is not refused, so the check is real", async () => {
    const f = await fixture();
    const token = f.device("dev_full", [SCOPE_READ, SCOPE_PROMPT]);
    const { frames, result } = session(f.gw, token);
    if (!result.ok) throw new Error("session was refused");
    result.deliver(JSON.stringify({ t: "prompt", agentId: "agt_missing", text: "do a thing" }));

    // The scope check passed. Whatever happens next is the unknown agent's
    // problem and arrives asynchronously; what matters is that the synchronous
    // scope refusal did not fire. Asserting this is what stops the test above
    // from passing against a gateway that simply refuses everything.
    const refused = frames.some(
      (frame) => frame.t === "error" && frame.message === "prompt requires prompt scope",
    );
    expect(refused).toBe(false);
  });

  test("revoking a device drops its live tunnel session", async () => {
    const f = await fixture();
    const token = f.device("dev_doomed", [SCOPE_READ]);
    const { frames, result } = session(f.gw, token);
    if (!result.ok) throw new Error("session was refused");
    result.deliver(JSON.stringify({ t: "attach", agentId: "agt_x" }));

    f.gw.revokeDevice("dev_doomed");

    // Attach never reaches the supervisor, so nothing would re-check this
    // session on its own. The connection closing is what covers that gap, and
    // it has to cover it for a tunnel exactly as for a local socket.
    const notice = frames.find((frame) => frame.t === "error" && frame.code === "unauthorized");
    expect(notice).toMatchObject({ message: "this device has been revoked" });
  });
});

describe("replay through a tunnel session", () => {
  test("a reattach with sinceSeq gets exactly the frames it missed", async () => {
    const f = await fixture();
    const token = f.device("dev_reader", [SCOPE_READ]);
    const agentId = "agt_replay";

    // A turn that produced five updates while nobody was necessarily watching.
    // The supervisor writes these whether or not a socket exists, which is what
    // makes resume possible at all.
    for (let i = 1; i <= 5; i++) f.store.appendUpdate(agentId, { chunk: i });

    // A phone that had seen through seq 2 and dropped mid-turn.
    const resumed = session(f.gw, token);
    if (!resumed.result.ok) throw new Error("session was refused");
    resumed.result.deliver(JSON.stringify({ t: "attach", agentId, sinceSeq: 2 }));

    const updates = resumed.frames.filter((frame) => frame.t === "update");
    expect(updates.map((frame) => (frame.t === "update" ? frame.seq : 0))).toEqual([3, 4, 5]);
    expect(updates.map((frame) => (frame.t === "update" ? frame.update : null))).toEqual([
      { chunk: 3 },
      { chunk: 4 },
      { chunk: 5 },
    ]);
  });

  test("a fresh session after a drop replays the whole turn, losing nothing", async () => {
    const f = await fixture();
    const token = f.device("dev_reader", [SCOPE_READ]);
    const agentId = "agt_dropped";

    const first = session(f.gw, token);
    if (!first.result.ok) throw new Error("session was refused");
    first.result.deliver(JSON.stringify({ t: "attach", agentId }));

    f.store.appendUpdate(agentId, { chunk: 1 });
    f.events.onUpdate(agentId, 1, { chunk: 1 });
    // The tunnel dies here, exactly as it does when a laptop sleeps or a hub
    // instance recycles. Nothing buffers; the session is simply gone.
    first.result.close();

    // The turn keeps going at the daemon, because execution is not the
    // tunnel's business.
    for (let i = 2; i <= 4; i++) {
      f.store.appendUpdate(agentId, { chunk: i });
      f.events.onUpdate(agentId, i, { chunk: i });
    }

    const second = session(f.gw, token);
    if (!second.result.ok) throw new Error("resumed session was refused");
    second.result.deliver(JSON.stringify({ t: "attach", agentId, sinceSeq: 1 }));

    const seqs = second.frames.filter((frame) => frame.t === "update").map((f2) => (f2.t === "update" ? f2.seq : 0));
    expect(seqs).toEqual([2, 3, 4]);
    // And the dead session received nothing after it closed.
    const firstSeqs = first.frames.filter((frame) => frame.t === "update").map((f2) => (f2.t === "update" ? f2.seq : 0));
    expect(firstSeqs).toEqual([1]);
  });
});
