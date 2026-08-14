/**
 * A real hub, real daemons, real clients, over real websockets.
 *
 * Nothing here mocks the relay. Frames go out over loopback and come back, so
 * a test that says a client reached a daemon means exactly that.
 */

import { generateIdentity, type DaemonKeyPair, type TunnelSocketLike } from "@ompd/tunnel";
import { connectThroughHub } from "@ompd/tunnel";
import { MemoryBackplane, MemoryBus } from "../src/backplane.ts";
import { Hub } from "../src/hub.ts";
import { MemoryRegistry } from "../src/registry.ts";
import { RecordingAudit } from "../src/audit.ts";

export const OPERATOR_TOKEN = "operator-secret";

/** Adapts a real `WebSocket` onto the small shape both sides expect. */
export function browserTransport(url: string): TunnelSocketLike {
  const socket = new WebSocket(url);
  const shim: TunnelSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    set readyState(_value: number) {
      // The adapter reports the live socket's state; assignment is ignored.
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  socket.onopen = () => shim.onopen?.();
  socket.onclose = (event) => shim.onclose?.({ code: event.code, reason: event.reason });
  socket.onerror = () => shim.onerror?.({ message: "socket error" });
  socket.onmessage = (event) => shim.onmessage?.(String(event.data));
  return shim;
}

export interface HubFixture {
  hub: Hub;
  url: string;
  audit: RecordingAudit;
  backplane: MemoryBackplane;
}

export interface FleetFixture {
  bus: MemoryBus;
  registry: MemoryRegistry;
  hubs: HubFixture[];
  stop(): Promise<void>;
}

/** Start `count` hub instances over one shared routing table. */
export async function startHubs(count: number): Promise<FleetFixture> {
  const bus = new MemoryBus();
  const registry = new MemoryRegistry();
  const hubs: HubFixture[] = [];

  for (let i = 0; i < count; i++) {
    const audit = new RecordingAudit();
    const backplane = new MemoryBackplane(bus, `inst-${i}`);
    const hub = new Hub({
      registry,
      backplane,
      operatorToken: OPERATOR_TOKEN,
      host: "127.0.0.1",
      port: 0,
      audit: audit.record,
    });
    const port = await hub.listen();
    hubs.push({ hub, url: `ws://127.0.0.1:${port}`, audit, backplane });
  }

  return {
    bus,
    registry,
    hubs,
    async stop() {
      for (const entry of hubs) await entry.hub.stop();
    },
  };
}

export function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/** Enroll a fresh daemon identity with the hub over its operator route. */
export async function enroll(fixture: FleetFixture, label: string): Promise<DaemonKeyPair> {
  const identity = generateIdentity();
  await fixture.registry.enroll({ publicKey: identity.publicKey, label });
  return identity;
}

export { connectThroughHub };

/**
 * Resolve once `check` holds, or throw naming what was awaited.
 *
 * These tests drive real websockets across a real relay, so the events they
 * wait on are delivered by the platform's own event loop and cannot be
 * advanced by a fake clock. Polling a condition is still strictly better than
 * a fixed sleep: it finishes as soon as the thing happens, and a failure
 * reports the condition rather than a bare timeout.
 */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}
