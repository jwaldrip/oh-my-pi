/**
 * `platform/socket.ts`'s hub socket factory: the seam that keeps a bearer
 * token out of the one place it must never land, the url handed to the wire.
 *
 * `createHubSocketFactory`'s `transport` option exists precisely so a caller
 * can substitute the network without touching anything else `connectThroughHub`
 * does, so that is what these tests stub, rather than replacing
 * `connectThroughHub` itself. `FakeDaemonWire` below plays hub-and-daemon
 * behind that seam using `@ompd/tunnel`'s own handshake and sealed-channel
 * functions for real: the proof that the token reaches the daemon rather than
 * the url is that it comes out the other end of the same encryption a live hub
 * would relay unread.
 */

import { describe, expect, test } from "bun:test";
import type { ClientHello, ClientToHub, DaemonKeyPair, HubToClient, TunnelSocketLike } from "@ompd/tunnel";
import { answerClientHandshake, generateIdentity, PROTOCOL_VERSION, SealedChannel } from "@ompd/tunnel";
import type { ClientCredential, SessionReady } from "@ompd/tunnel";
import { createHubSocketFactory } from "../src/platform/socket.ts";

const SESSION_ID = "sess_test0001";

/** Satisfies the interface; never asked to do anything in the tests that use it. */
class InertWire implements TunnelSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  send(): void {}
  close(): void {}
}

/**
 * Stands in for the hub and the daemon behind it. Answers the client's real
 * handshake with `answerClientHandshake`, opens the client's sealed credential
 * with a real `SealedChannel`, and once open can seal an application frame
 * back the same way a live daemon would. Nothing here is a stand-in for the
 * cryptography; only the transport is fake.
 */
class FakeDaemonWire implements TunnelSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;

  /** The token this daemon actually decrypted, once the credential arrives. */
  receivedToken: string | null = null;

  readonly #identity: DaemonKeyPair;
  #channel: SealedChannel | null = null;
  #outRseq = 0;

  constructor(identity: DaemonKeyPair) {
    this.#identity = identity;
    // Deferred: `TunnelSocket`'s constructor attaches `onmessage` right after
    // `transport(url)` returns, and a synchronous "linked" here would fire
    // before that handler exists to receive it.
    queueMicrotask(() => {
      const linked: HubToClient = {
        t: "linked",
        v: PROTOCOL_VERSION,
        sessionId: SESSION_ID,
        daemonId: identity.daemonId,
        publicKey: identity.publicKey,
      };
      this.onmessage?.(JSON.stringify(linked));
    });
  }

  send(data: string): void {
    void this.#onClientFrame(JSON.parse(data) as ClientToHub);
  }

  close(): void {}

  /** Seals `plaintext` as an application frame, the way an open session streams updates. */
  async pushSessionFrame(plaintext: string): Promise<void> {
    if (this.#channel === null) throw new Error("no sealed channel yet: the handshake has not completed");
    this.#deliver(await this.#channel.seal(plaintext));
  }

  async #onClientFrame(frame: ClientToHub): Promise<void> {
    if (frame.t !== "data") return;

    if (this.#channel === null) {
      // First frame: the client's plaintext hello.
      const hello = JSON.parse(frame.payload) as ClientHello;
      const { auth, keys } = await answerClientHandshake({
        hello,
        sessionId: SESSION_ID,
        daemonId: this.#identity.daemonId,
        privateKey: this.#identity.privateKey,
      });
      this.#channel = new SealedChannel(keys, "daemon");
      this.#deliver(JSON.stringify(auth));
      return;
    }

    // Second frame: the sealed credential. Opening it is the only way to read
    // the token, which is the entire property this file exists to prove.
    const opened = await this.#channel.open(frame.payload);
    const credential = JSON.parse(opened) as ClientCredential;
    this.receivedToken = credential.token;
    const ready: SessionReady = { t: "ready", deviceId: "dev_test" };
    this.#deliver(await this.#channel.seal(JSON.stringify(ready)));
  }

  #deliver(payload: string): void {
    const frame: HubToClient = { t: "data", rseq: this.#outRseq++, payload };
    this.onmessage?.(JSON.stringify(frame));
  }
}

describe("createHubSocketFactory", () => {
  test("hands the wire transport a url with no token, whatever else the url OmpdClient built carried", () => {
    let seenUrl: string | null = null;
    const factory = createHubSocketFactory({
      daemonId: generateIdentity().daemonId,
      transport: (url) => {
        seenUrl = url;
        return new InertWire();
      },
    });

    factory("wss://hub.example.com/relay?region=us&token=super-secret");

    if (seenUrl === null) throw new Error("the transport was never asked to dial");
    expect(seenUrl).not.toContain("token=");
    expect(seenUrl).not.toContain("super-secret");
  });

  test("a url carrying no token is a refusal before the transport seam is ever reached", () => {
    const factory = createHubSocketFactory({
      daemonId: generateIdentity().daemonId,
      transport: () => {
        throw new Error("the transport must never be asked to dial without a token");
      },
    });

    expect(() => factory("wss://hub.example.com")).toThrow();
  });

  test("the token survives only inside the real sealed handshake, and session data arrives adapted onto { data }", async () => {
    const identity = generateIdentity();
    const wires: FakeDaemonWire[] = [];
    const factory = createHubSocketFactory({
      daemonId: identity.daemonId,
      transport: (url) => {
        // The stripped base this factory owns; the sealed exchange below is
        // `@ompd/tunnel`'s job, not this file's, so this is the one assertion
        // about the url worth repeating at the point the credential actually
        // has to have already left it.
        expect(url).not.toContain("token=");
        expect(url).not.toContain("super-secret");
        const wire = new FakeDaemonWire(identity);
        wires.push(wire);
        return wire;
      },
    });

    const socket = factory("wss://hub.example.com?token=super-secret");
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = (error) => reject(error instanceof Error ? error : new Error(String(error)));
    });

    const wire = wires.at(-1);
    if (!wire) throw new Error("no wire was ever dialed");
    expect(wire.receivedToken).toBe("super-secret");

    const sessionFrame = new Promise<unknown>((resolve) => {
      socket.onmessage = (message) => resolve(message);
    });
    await wire.pushSessionFrame("application-payload");

    expect(await sessionFrame).toEqual({ data: "application-payload" });
  });
});
