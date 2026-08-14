/**
 * A tunnel session, wearing a websocket's face.
 *
 * `OmpdClient` already knows how to reconnect, track a per-agent high-water
 * mark, and re-`attach` with `sinceSeq`. None of that should be written a
 * second time for the tunnel, and a second copy would be the one that drifts.
 * So the tunnel presents the same small surface a `WebSocket` does, and the
 * client drives it without knowing a hub exists.
 *
 * That is what preserves lossless resume end to end. The tunnel never inspects
 * a session frame, never renumbers a `seq`, and never buffers across a
 * reconnect. When a session dies the socket closes; the client reconnects,
 * sends `attach` with the last seq it saw, and the daemon replays from its
 * durable update log. The tunnel's only obligation is to close loudly rather
 * than sit there looking healthy while frames go nowhere.
 *
 * ## The token never reaches the hub
 *
 * `OmpdClient` appends `?token=` to the URL it opens, because against a local
 * daemon that is the only way a browser can authenticate a websocket. Through a
 * hub that would hand the bearer straight to the relay. So this module takes
 * the token as its own argument, opens a credential-free URL, and presents the
 * token only inside the sealed channel, where the daemon is the only party that
 * can open it. `hubSocketUrl` exists to strip a token out of a URL that already
 * has one, for callers holding the shape `OmpdClient` builds.
 */

import { SealedChannel } from "./channel.ts";
import { beginClientHandshake, type ClientCredential, type ClientHandshake, type DaemonAuth, type SessionReady } from "./handshake.ts";
import type { DaemonId } from "./identity.ts";
import { type ClientToHub, type HubToClient, parseFrame } from "./protocol.ts";

/** The slice of a websocket this module needs, and the slice it presents. */
export interface TunnelSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((info: { code: number; reason: string }) => void) | null;
  onerror: ((info: { message: string }) => void) | null;
  onmessage: ((data: string) => void) | null;
}

export type TunnelTransportFactory = (url: string) => TunnelSocketLike;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Where a session is in the handshake.
 *
 * `open` is the only state in which a caller's frame is written, and it is
 * reached only after the daemon has accepted a credential. Anything handed over
 * earlier is queued, so a client that sends immediately does not lose its first
 * frame and does not get it sent unauthenticated either.
 */
type Phase = "linking" | "authenticating" | "confirming" | "open" | "closed";

export interface TunnelSocketOptions {
  /** Hub base URL, for example `wss://hub.example.com`. */
  hubUrl: string;
  /** The daemon this client paired with. Pinned, never taken from the hub. */
  daemonId: DaemonId;
  /** The bearer token for that daemon. Sealed before it leaves this process. */
  token: string;
  transport: TunnelTransportFactory;
}

/**
 * Strip a credential out of a socket URL and return the hub base.
 *
 * For callers that hold the `?token=` form and must not forward it.
 */
export function hubSocketUrl(url: string): { base: string; token: string | null } {
  const parsed = URL.parse(url);
  if (parsed === null) return { base: url, token: null };
  const token = parsed.searchParams.get("token");
  parsed.searchParams.delete("token");
  parsed.search = parsed.searchParams.toString();
  return { base: parsed.toString().replace(/\?$/, ""), token };
}

export function connectThroughHub(opts: TunnelSocketOptions): TunnelSocketLike {
  return new TunnelSocket(opts);
}

class TunnelSocket implements TunnelSocketLike {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;

  readonly #daemonId: DaemonId;
  readonly #token: string;
  readonly #wire: TunnelSocketLike;
  readonly #handshake: ClientHandshake;

  #phase: Phase = "linking";
  #channel: SealedChannel | null = null;
  #link: { sessionId: string; publicKey: string } | null = null;
  /** Relay sequence, counting handshake frames as well as sealed ones. */
  #sent = 0;
  #expected = 0;
  /** Frames handed over before the channel was ready, in order. */
  readonly #queued: string[] = [];

  constructor(opts: TunnelSocketOptions) {
    this.#daemonId = opts.daemonId;
    this.#token = opts.token;
    this.#handshake = beginClientHandshake(opts.daemonId);

    const base = opts.hubUrl.replace(/\/+$/, "");
    this.#wire = opts.transport(`${base}/v1/link/${encodeURIComponent(opts.daemonId)}`);
    this.#wire.onmessage = (data) => void this.#onWire(data);
    this.#wire.onclose = (info) => this.#finish(info.code, info.reason);
    this.#wire.onerror = (info) => this.onerror?.(info);
    // Nothing to do on open: the hub speaks first with `linked`, and the
    // handshake cannot start before a session id exists to bind into it.
    this.#wire.onopen = null;
  }

  send(data: string): void {
    if (this.#phase === "closed") return;
    if (this.#phase !== "open") {
      this.#queued.push(data);
      return;
    }
    void this.#seal(data);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.readyState = CLOSED;
    this.#wire.close(code, reason);
  }

  // -- outbound --------------------------------------------------------------

  async #seal(data: string): Promise<void> {
    const channel = this.#channel;
    if (channel === null || this.#phase === "closed") return;
    try {
      this.#write(await channel.seal(data));
    } catch (cause) {
      this.#fail(`could not seal a frame: ${describe(cause)}`);
    }
  }

  /** Write one relay frame, sealed or not, advancing the relay sequence. */
  #write(payload: string): void {
    this.#wire.send(JSON.stringify({ t: "data", rseq: this.#sent++, payload } satisfies ClientToHub));
  }

  // -- inbound ---------------------------------------------------------------

  async #onWire(raw: string): Promise<void> {
    const frame = parseFrame<HubToClient>(raw);
    if (!frame) return;

    switch (frame.t) {
      case "linked":
        this.#onLinked(frame);
        return;
      case "data":
        await this.#onData(frame);
        return;
      case "refused":
        this.#fail(`${frame.code}: ${frame.message}`, 4400);
        return;
      case "peer_gone":
        // Not an error. The daemon went away, and the client's own reconnect
        // with `sinceSeq` is exactly the right response.
        this.#finish(4410, frame.reason);
        this.#wire.close(4410, "peer gone");
        return;
      case "ping":
        this.#wire.send(JSON.stringify({ t: "pong" } satisfies ClientToHub));
        return;
      case "ack":
        return;
    }
  }

  #onLinked(frame: Extract<HubToClient, { t: "linked" }>): void {
    if (this.#phase !== "linking") return;
    if (frame.daemonId !== this.#daemonId) {
      // The hub answered for a machine this client did not ask for.
      this.#fail(`hub linked ${frame.daemonId}, expected ${this.#daemonId}`);
      return;
    }
    this.#link = { sessionId: frame.sessionId, publicKey: frame.publicKey };
    this.#phase = "authenticating";
    // Unsealed, necessarily: this frame is what establishes the key. It carries
    // a nonce and an ephemeral public key and nothing worth hiding.
    this.#write(JSON.stringify(this.#handshake.hello));
  }

  async #onData(frame: Extract<HubToClient, { t: "data" }>): Promise<void> {
    if (frame.rseq !== this.#expected) {
      // A gap means the relay lost something. Continuing would hand the client
      // a transcript with a hole in it and no way to know.
      this.#fail(`relay delivered frame ${frame.rseq}, expected ${this.#expected}`);
      return;
    }
    this.#expected++;

    switch (this.#phase) {
      case "authenticating":
        await this.#onDaemonAuth(frame.payload);
        return;
      case "confirming":
        await this.#onReady(frame.payload);
        return;
      case "open":
        await this.#onSessionFrame(frame.payload);
        return;
      default:
        this.#fail("the hub sent session data before the session existed");
    }
  }

  async #onDaemonAuth(payload: string): Promise<void> {
    const link = this.#link;
    const auth = parseFrame<DaemonAuth>(payload);
    if (link === null || !auth || auth.t !== "auth") {
      this.#fail("daemon did not answer the handshake");
      return;
    }

    try {
      // Verifies the fingerprint against the pinned id and the signature
      // against the transcript. A hub that swapped either fails here.
      const keys = await this.#handshake.accept(auth, { sessionId: link.sessionId, publicKey: link.publicKey });
      this.#channel = new SealedChannel(keys, "client");
    } catch (cause) {
      this.#fail(`daemon could not be verified: ${describe(cause)}`);
      return;
    }

    this.#phase = "confirming";
    const credential: ClientCredential = { t: "credential", token: this.#token };
    await this.#seal(JSON.stringify(credential));
  }

  async #onReady(payload: string): Promise<void> {
    const channel = this.#channel;
    if (channel === null) return;
    let ready: SessionReady | null;
    try {
      ready = parseFrame<SessionReady>(await channel.open(payload));
    } catch (cause) {
      this.#fail(`session confirmation did not authenticate: ${describe(cause)}`);
      return;
    }
    if (!ready || ready.t !== "ready") {
      this.#fail("daemon refused the credential");
      return;
    }

    this.#ack(channel);
    this.#phase = "open";
    this.readyState = OPEN;
    this.onopen?.();
    // Anything the caller handed over during the handshake goes now, in the
    // order it was given.
    for (const queued of this.#queued.splice(0)) void this.#seal(queued);
  }

  async #onSessionFrame(payload: string): Promise<void> {
    const channel = this.#channel;
    if (channel === null) return;
    let plaintext: string;
    try {
      plaintext = await channel.open(payload);
    } catch (cause) {
      this.#fail(`a relayed frame did not authenticate: ${describe(cause)}`);
      return;
    }
    this.#ack(channel);
    this.onmessage?.(plaintext);
  }

  /**
   * Report how much this side has actually taken in.
   *
   * The relay uses it to notice a frame that went missing with nothing behind
   * it, which a sequence gap alone can never reveal.
   */
  #ack(channel: SealedChannel): void {
    this.#wire.send(JSON.stringify({ t: "ack", received: channel.received } satisfies ClientToHub));
  }

  #fail(message: string, code = 4500): void {
    this.onerror?.({ message });
    this.#finish(code, message);
    this.#wire.close(code, "tunnel failed");
  }

  #finish(code: number, reason: string): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
