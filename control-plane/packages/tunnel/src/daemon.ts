/**
 * The daemon's outbound leg.
 *
 * The laptop is behind NAT and asleep half the time, so nothing inbound will
 * ever reach it. It dials the hub instead and holds the connection: no port to
 * forward, nothing to configure on a router, and a changing IP is not an event.
 *
 * Reconnection is the normal case, not the exception. Cloud Run terminates any
 * request at sixty minutes, websockets included, so a healthy connection is
 * closed on a timer whatever else happens; the laptop sleeping and the hub
 * redeploying do the same thing more often. This reconnects with backoff
 * forever and treats a close as routine.
 *
 * Nothing is buffered across a reconnect. Sessions die with the connection and
 * their clients are told, because the durable copy of a turn lives in the
 * daemon's own update log and a client resumes from it with `attach{sinceSeq}`.
 * A relay that held frames to redeliver would be a second, worse version of
 * that, and could deliver a prompt into a session already torn down.
 *
 * What decides who a client is lives behind `SessionAcceptor`. This module
 * carries a token from the sealed channel to that seam and does nothing else
 * with it: it never inspects one, never caches one, and has no opinion about
 * scopes.
 */

import { SealedChannel } from "./channel.ts";
import { toBase64Url } from "./bytes.ts";
import {
  answerClientHandshake,
  type ClientCredential,
  type ClientHello,
  HandshakeError,
  type SessionReady,
} from "./handshake.ts";
import { type DaemonKeyPair, signWith } from "./identity.ts";
import {
  type DaemonToHub,
  type HubToDaemon,
  parseFrame,
  PROTOCOL_VERSION,
  type RefusalCode,
  registrationLabel,
} from "./protocol.ts";

/** The slice of a websocket this dialer needs. A real `WebSocket` satisfies it. */
export interface DialSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((info: { code: number; reason: string }) => void) | null;
  onerror: ((info: { message: string }) => void) | null;
  onmessage: ((data: string) => void) | null;
}

export type DialTransport = (url: string) => DialSocket;

/** A session the acceptor admitted, or the reason it did not. */
export type AcceptResult =
  | {
      ok: true;
      deviceId: string;
      /** Hand one decrypted client frame to whatever serves this session. */
      deliver(raw: string): void;
      close(): void;
    }
  | { ok: false; reason: "unknown" | "revoked" };

/**
 * Turns a bearer token into a session, or refuses it.
 *
 * The single point at which the tunnel asks "who is this", so there is exactly
 * one authorization decision per session and it is made by the thing that owns
 * credentials rather than by the transport that carried one.
 */
export interface SessionAcceptor {
  accept(token: string, send: (raw: string) => void): AcceptResult;
}

/**
 * What one client session came to, reported once it is settled.
 *
 * Named rather than inlined into the callback because a caller has to be able
 * to hold one: the daemon's own tests collect them, and an operator-facing
 * audit row is built from the same three fields.
 */
export interface SessionEvent {
  sessionId: string;
  outcome: "ok" | "denied";
  /** Present only when the acceptor recognised the credential. */
  deviceId?: string;
  /** Why a `denied` session was refused, in the acceptor's own words. */
  reason?: string;
}

/** A raw webhook relayed from the public hub to this daemon only. */
export interface WebhookRequest {
  requestId: string;
  routineId: string;
  secret: string;
  body: string;
  contentType?: string;
}

/** The daemon gateway's response to one relayed webhook. */
export interface WebhookResponse {
  status: number;
  body: string;
  contentType?: string;
}

export interface TunnelDaemonOptions {
  hubUrl: string;
  identity: DaemonKeyPair;
  acceptor: SessionAcceptor;
  transport?: DialTransport;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onLog?: (message: string) => void;
  onRegistered?: (instanceId: string) => void;
  onRefused?: (code: RefusalCode, message: string) => void;
  onSession?: (event: SessionEvent) => void;
  onWebhook?: (request: WebhookRequest) => Promise<WebhookResponse>;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  random?: () => number;
}

const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

interface Session {
  sessionId: string;
  channel: SealedChannel | null;
  admitted: Extract<AcceptResult, { ok: true }> | null;
  sent: number;
  expected: number;
}

export class TunnelDaemon {
  readonly #hubUrl: string;
  readonly #identity: DaemonKeyPair;
  readonly #acceptor: SessionAcceptor;
  readonly #transport: DialTransport;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #onLog: (message: string) => void;
  readonly #onRegistered: ((instanceId: string) => void) | undefined;
  readonly #onRefused: ((code: RefusalCode, message: string) => void) | undefined;
  readonly #onSession: TunnelDaemonOptions["onSession"];
  readonly #onWebhook: ((request: WebhookRequest) => Promise<WebhookResponse>) | undefined;
  readonly #schedule: (fn: () => void, ms: number) => { cancel(): void };
  readonly #random: () => number;

  readonly #sessions = new Map<string, Session>();
  #socket: DialSocket | null = null;
  #registered = false;
  #attempt = 0;
  #stopped = true;
  #retry: { cancel(): void } | null = null;

  constructor(opts: TunnelDaemonOptions) {
    this.#hubUrl = opts.hubUrl.replace(/\/+$/, "");
    this.#identity = opts.identity;
    this.#acceptor = opts.acceptor;
    this.#transport = opts.transport ?? ((url) => new WebSocket(url) as unknown as DialSocket);
    this.#minBackoffMs = opts.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.#maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#onLog = opts.onLog ?? (() => {});
    this.#onRegistered = opts.onRegistered;
    this.#onRefused = opts.onRefused;
    this.#onSession = opts.onSession;
    this.#onWebhook = opts.onWebhook;
    this.#random = opts.random ?? Math.random;
    this.#schedule =
      opts.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return {
          cancel: () => clearTimeout(handle),
        };
      });
  }

  get daemonId(): string {
    return this.#identity.daemonId;
  }

  /** Whether the hub has accepted this daemon's registration right now. */
  get registered(): boolean {
    return this.#registered;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#retry?.cancel();
    this.#retry = null;
    this.#tearDownAll();
    this.#socket?.close(1000, "shutting down");
    this.#socket = null;
    this.#registered = false;
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = this.#transport(`${this.#hubUrl}/v1/daemon`);
    this.#socket = socket;
    socket.onmessage = (data) => void this.#onFrame(data);
    socket.onerror = (info) => this.#onLog(`tunnel error: ${info.message}`);
    socket.onclose = (info) => this.#onClose(info);
    socket.onopen = null;
  }

  #onClose(info: { code: number; reason: string }): void {
    this.#registered = false;
    this.#socket = null;
    // Every session died with the connection. Their clients hear it from the
    // hub and resume against the update log.
    this.#tearDownAll();
    if (this.#stopped) return;

    const ceiling = Math.min(this.#maxBackoffMs, this.#minBackoffMs * 2 ** this.#attempt);
    // Full jitter. A fleet reconnecting in lockstep after a hub redeploy is a
    // thundering herd against the thing that just came back.
    this.#attempt++;
    this.#onLog(`tunnel closed (${info.code} ${info.reason}); reconnecting`);
    this.#retry = this.#schedule(() => this.#connect(), Math.round(ceiling * this.#random()));
  }

  async #onFrame(raw: string): Promise<void> {
    const frame = parseFrame<HubToDaemon>(raw);
    if (!frame) return;

    switch (frame.t) {
      case "challenge":
        this.#onChallenge(frame);
        return;
      case "registered":
        this.#registered = true;
        this.#attempt = 0;
        this.#onRegistered?.(frame.instanceId);
        return;
      case "refused":
        // The hub will refuse again for the same reason, so this is worth
        // saying loudly rather than retrying quietly forever.
        this.#onRefused?.(frame.code, frame.message);
        this.#onLog(`hub refused this daemon: ${frame.code}: ${frame.message}`);
        return;
      case "open":
        this.#sessions.set(frame.sessionId, {
          sessionId: frame.sessionId,
          channel: null,
          admitted: null,
          sent: 0,
          expected: 0,
        });
        return;
      case "data":
        await this.#onData(frame);
        return;
      case "close":
        this.#tearDown(frame.sessionId);
        return;
      case "ack":
        return;
      case "ping":
        this.#send({ t: "pong" });
        return;
      case "webhook_request":
        await this.#onWebhookRequest(frame);
        return;
    }
  }

  #onChallenge(frame: Extract<HubToDaemon, { t: "challenge" }>): void {
    if (frame.v !== PROTOCOL_VERSION) {
      this.#onLog(`hub speaks tunnel v${frame.v}, this daemon speaks v${PROTOCOL_VERSION}`);
      this.#socket?.close(4400, "version mismatch");
      return;
    }
    const signed = new TextEncoder().encode(`${registrationLabel()}|${frame.nonce}|${this.#identity.daemonId}`);
    this.#send({
      t: "register",
      v: PROTOCOL_VERSION,
      daemonId: this.#identity.daemonId,
      publicKey: this.#identity.publicKey,
      sig: signWith(this.#identity.privateKey, signed),
    });
  }


  async #onWebhookRequest(frame: Extract<HubToDaemon, { t: "webhook_request" }>): Promise<void> {
    const handler = this.#onWebhook;
    if (handler === undefined) {
      this.#send({
        t: "webhook_response",
        requestId: frame.requestId,
        status: 503,
        body: toBase64Url(new TextEncoder().encode(JSON.stringify({ error: "webhooks_unavailable" }))),
        contentType: "application/json",
      });
      return;
    }

    try {
      const response = await handler({
        requestId: frame.requestId,
        routineId: frame.routineId,
        secret: frame.secret,
        body: frame.body,
        contentType: frame.contentType,
      });
      this.#send({
        t: "webhook_response",
        requestId: frame.requestId,
        status: response.status,
        body: response.body,
        contentType: response.contentType,
      });
    } catch {
      this.#send({
        t: "webhook_response",
        requestId: frame.requestId,
        status: 500,
        body: toBase64Url(new TextEncoder().encode(JSON.stringify({ error: "webhook_failed" }))),
        contentType: "application/json",
      });
    }
  }
  async #onData(frame: Extract<HubToDaemon, { t: "data" }>): Promise<void> {
    const session = this.#sessions.get(frame.sessionId);
    if (!session) return;
    if (frame.rseq !== session.expected) {
      this.#refuse(session, "relay_broken", `frame ${frame.rseq} arrived out of order`);
      return;
    }
    session.expected++;

    if (session.channel === null) await this.#onHello(session, frame.payload);
    else if (session.admitted === null) await this.#onCredential(session, frame.payload);
    else await this.#onSessionFrame(session, frame.payload);
  }

  /** First frame of a session: unsealed, because it is what makes the key. */
  async #onHello(session: Session, payload: string): Promise<void> {
    const hello = parseFrame<ClientHello>(payload);
    if (!hello || hello.t !== "hello") {
      this.#refuse(session, "bad_request", "first frame was not a hello");
      return;
    }
    try {
      const answered = await answerClientHandshake({
        hello,
        sessionId: session.sessionId,
        daemonId: this.#identity.daemonId,
        privateKey: this.#identity.privateKey,
      });
      session.channel = new SealedChannel(answered.keys, "daemon");
      this.#relay(session, JSON.stringify(answered.auth));
    } catch (cause) {
      this.#refuse(
        session,
        cause instanceof HandshakeError ? cause.code : "bad_request",
        cause instanceof Error ? cause.message : "handshake failed",
      );
    }
  }

  /**
   * Second frame, sealed: the client's bearer token.
   *
   * The only place the tunnel sees a credential, and all it does is hand it to
   * the acceptor. Identity, scopes, and the decision all come back from there.
   */
  async #onCredential(session: Session, payload: string): Promise<void> {
    const channel = session.channel;
    if (channel === null) return;

    let credential: ClientCredential | null;
    try {
      credential = parseFrame<ClientCredential>(await channel.open(payload));
    } catch {
      this.#refuse(session, "bad_request", "credential frame did not authenticate");
      return;
    }
    if (!credential || credential.t !== "credential" || typeof credential.token !== "string") {
      this.#refuse(session, "bad_request", "credential frame was malformed");
      return;
    }

    const admitted = this.#acceptor.accept(credential.token, (raw) => void this.#sealTo(session, raw));
    if (!admitted.ok) {
      this.#onSession?.({ sessionId: session.sessionId, outcome: "denied", reason: admitted.reason });
      this.#refuse(session, admitted.reason === "revoked" ? "revoked" : "unknown_client", `credential was ${admitted.reason}`);
      return;
    }

    session.admitted = admitted;
    this.#onSession?.({ sessionId: session.sessionId, outcome: "ok", deviceId: admitted.deviceId });
    await this.#sealTo(session, JSON.stringify({ t: "ready", deviceId: admitted.deviceId } satisfies SessionReady));
  }

  async #onSessionFrame(session: Session, payload: string): Promise<void> {
    const channel = session.channel;
    const admitted = session.admitted;
    if (channel === null || admitted === null) return;
    let plaintext: string;
    try {
      plaintext = await channel.open(payload);
    } catch {
      this.#refuse(session, "relay_broken", "a relayed frame did not authenticate");
      return;
    }
    this.#send({ t: "ack", sessionId: session.sessionId, received: channel.received });
    // Straight through to whatever serves this session, which runs every check
    // it runs for a local connection. Nothing is inspected on the way.
    admitted.deliver(plaintext);
  }

  async #sealTo(session: Session, plaintext: string): Promise<void> {
    const channel = session.channel;
    if (channel === null || !this.#sessions.has(session.sessionId)) return;
    try {
      this.#relay(session, await channel.seal(plaintext));
    } catch {
      this.#refuse(session, "relay_broken", "could not seal a frame");
    }
  }

  #relay(session: Session, payload: string): void {
    this.#send({ t: "data", sessionId: session.sessionId, rseq: session.sent++, payload });
  }

  #refuse(session: Session, code: RefusalCode, message: string): void {
    this.#send({ t: "close", sessionId: session.sessionId, code, message });
    this.#tearDown(session.sessionId);
  }

  #tearDown(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.admitted?.close();
  }

  #tearDownAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.#tearDown(sessionId);
  }

  #send(frame: DaemonToHub): void {
    try {
      this.#socket?.send(JSON.stringify(frame));
    } catch {
      // The socket went away between a decision and this send. `onclose` tears
      // the sessions down; there is nothing to report to here.
    }
  }
}
