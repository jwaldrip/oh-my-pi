/**
 * The relay.
 *
 * Daemons dial out and hold a websocket; clients connect and are joined to one
 * of them. The hub moves sealed bytes between the two and knows nothing about
 * what they mean.
 *
 * ## What this process can see
 *
 * Routing metadata, and only that: which daemon ids are enrolled, which are
 * connected and to which instance, how many sessions exist, how big each frame
 * is and when it moved. It cannot read a prompt, a transcript, an approval, or
 * a bearer token, because the payload is sealed under a key derived from an
 * ephemeral exchange the hub does not participate in.
 *
 * It also cannot *become* a daemon or a device. It holds public keys, never
 * private ones, and never a token or a token hash. A hub that is fully
 * compromised can deny service, can lie about whether a daemon is online, and
 * can learn the traffic pattern. It cannot decrypt, and it cannot impersonate:
 * a client pins the daemon's fingerprint, and the daemon proves possession of
 * the matching private key on every session.
 *
 * ## Why the daemon leg is not authenticated by a secret
 *
 * A daemon signs a hub-issued nonce with its identity key. The hub stores only
 * the public half, so its own database is worth nothing to an attacker who
 * steals it, and a daemon can enroll with a second hub without either learning
 * anything about the other.
 */

import {
  type ClientToHub,
  type DaemonToHub,
  type HubToClient,
  type HubToDaemon,
  parseFrame,
  PROTOCOL_VERSION,
  type RefusalCode,
  registrationLabel,
  SESSION_ID_PATTERN,
  verifyWith,
} from "@ompd/tunnel";
import type { Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { HubAudit } from "./audit.ts";
import { consoleAudit } from "./audit.ts";
import type { Backplane, RelayEnvelope } from "./backplane.ts";
import type { DaemonRegistry, EnrolledDaemon } from "./registry.ts";

/** How long a presence lease lives, and how often it is renewed. */
const LEASE_TTL_MS = 30_000;

/**
 * How long a leg may hold unacknowledged frames before its session is torn
 * down.
 *
 * This is what catches a frame the backplane lost with nothing behind it. A
 * sequence gap only shows up when a *later* frame arrives, so the last frame of
 * a turn could otherwise vanish and leave a client waiting on a stream that has
 * already finished. Both legs report a cumulative count on a timer; if the
 * far side stays behind for longer than this, the session is torn down and the
 * client resumes from the daemon's update log.
 */
const ACK_DEADLINE_MS = 20_000;
const ACK_INTERVAL_MS = 5_000;

/** Frames a leg may burst, and its steady-state allowance. */
const RATE_BURST = 200;
const RATE_PER_SECOND = 50;

const MAX_FRAME_BYTES = 1_000_000;
const WEBHOOK_TIMEOUT_MS = 30_000;

type LegKind = "daemon" | "client";

interface DaemonLeg {
  kind: "daemon";
  daemonId: string | null;
  /** Nonce this leg must sign. Cleared once it has. */
  challenge: string | null;
  tokens: number;
  refilledAtMs: number;
}

interface ClientLeg {
  kind: "client";
  sessionId: string;
  daemonId: string;
  /** Instance holding the daemon leg. */
  daemonInstance: string;
  /** Frames relayed toward the daemon, and the count it has confirmed. */
  sent: number;
  acked: number;
  behindSinceMs: number | null;
  /** Next sequence expected from the daemon side. */
  expected: number;
  received: number;
  tokens: number;
  refilledAtMs: number;
}

type LegState = DaemonLeg | ClientLeg;

/** A session as the instance holding the *daemon* leg sees it. */
interface DaemonSession {
  sessionId: string;
  daemonId: string;
  clientInstance: string;
  sent: number;
  acked: number;
  behindSinceMs: number | null;
  expected: number;
  received: number;
}

interface PendingWebhook {
  daemonId: string;
  resolve: (response: Response) => void;
}

export interface HubOptions {
  registry: DaemonRegistry;
  backplane: Backplane;
  /**
   * Bearer that authorises enrollment. Compared in full, and absent means the
   * enrollment routes are closed rather than open.
   */
  operatorToken?: string;
  host?: string;
  port?: number;
  audit?: HubAudit;
  now?: () => number;
}

export class Hub {
  readonly #registry: DaemonRegistry;
  readonly #backplane: Backplane;
  readonly #operatorToken: string | undefined;
  readonly #host: string;
  readonly #port: number;
  readonly #audit: HubAudit;
  readonly #now: () => number;

  #server: Server<LegState> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  /** Daemon legs this instance holds, by daemon id. */
  readonly #daemons = new Map<string, ServerWebSocket<LegState>>();
  /** Client legs this instance holds, by session id. */
  readonly #clients = new Map<string, ServerWebSocket<LegState>>();
  /** Sessions whose daemon leg is here, by session id. */
  readonly #sessions = new Map<string, DaemonSession>();
  /** Public HTTP requests awaiting the daemon's correlated tunnel response. */
  readonly #webhooks = new Map<string, PendingWebhook>();
  /** Requesting hub instances for webhook requests this instance sent to a daemon. */
  readonly #webhookOrigins = new Map<string, string>();

  constructor(opts: HubOptions) {
    this.#registry = opts.registry;
    this.#backplane = opts.backplane;
    this.#operatorToken = opts.operatorToken;
    this.#host = opts.host ?? "0.0.0.0";
    this.#port = opts.port ?? 0;
    this.#audit = opts.audit ?? consoleAudit;
    this.#now = opts.now ?? Date.now;

    this.#backplane.onEnvelope((envelope) => this.#onEnvelope(envelope));
    this.#backplane.onDisrupted((reason) => this.#onDisrupted(reason));
  }

  get instanceId(): string {
    return this.#backplane.instanceId;
  }

  async listen(): Promise<number> {
    this.#server ??= Bun.serve({
      hostname: this.#host,
      port: this.#port,
      // Cloud Run terminates a request at 60 minutes, websockets included, so a
      // long-lived leg is not a thing this platform offers. Both ends treat a
      // close as routine and resume; see `docs/hub.md`.
      idleTimeout: 120,
      fetch: (req, server) => this.#fetch(req, server),
      websocket: {
        maxPayloadLength: MAX_FRAME_BYTES,
        open: (ws) => this.#open(ws),
        message: (ws, message) => void this.#message(ws, message),
        close: (ws) => void this.#close(ws),
      },
    });
    this.#timer ??= setInterval(() => void this.#tick(), ACK_INTERVAL_MS);
    // Bun reports no port for a unix-socket server. This one always binds TCP,
    // so an absent port means the listen did not do what was asked, and the
    // same check guards `Gateway#listen` for the same reason.
    const { port } = this.#server;
    if (port === undefined) throw new Error("hub did not bind a TCP port");
    return port;
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const daemonId of this.#daemons.keys()) await this.#backplane.releaseDaemon(daemonId);
    this.#server?.stop(true);
    this.#server = undefined;
    await this.#backplane.close();
  }

  // -- http ------------------------------------------------------------------

  async #fetch(req: Request, server: Server<LegState>): Promise<Response | undefined> {
    // `req.url` is absolute only when the request carried a Host header, and
    // HTTP/1.0 does not require one. Parsed bare, such a request throws, before
    // any authentication runs, so anything able to reach the port could produce
    // an unhandled exception on every request it sent.
    const url = URL.parse(req.url, `http://${this.#host}`);
    if (url === null) return Response.json({ error: "bad_request" }, { status: 400 });
    const path = url.pathname;

    if (path === "/v1/health") {
      return Response.json({ ok: true, instanceId: this.instanceId, v: PROTOCOL_VERSION });
    }

    if (path === "/v1/daemon") {
      // Nothing is authenticated here. The challenge below is, and until it is
      // answered this leg can do nothing but answer it.
      const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const data: DaemonLeg = {
        kind: "daemon",
        daemonId: null,
        challenge,
        tokens: RATE_BURST,
        refilledAtMs: this.#now(),
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const webhook = /^\/v1\/webhooks\/([^/]+)\/([^/]+)$/.exec(path);
    if (webhook) return await this.#forwardWebhook(req, webhook[1] ?? "", webhook[2] ?? "", url.searchParams.get("token"));

    const link = /^\/v1\/link\/([A-Za-z0-9_]+)$/.exec(path);
    if (link) return await this.#upgradeClient(req, server, link[1] ?? "");

    if (path === "/v1/enroll") return await this.#enroll(req);

    if (path.startsWith("/v1/enroll/")) return await this.#unenroll(req, path.slice("/v1/enroll/".length));

    return Response.json({ error: "not_found" }, { status: 404 });
  }
  async #forwardWebhook(
    req: Request,
    daemonId: string,
    routineId: string,
    querySecret: string | null,
  ): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });

    let enrolled: EnrolledDaemon | null;
    try {
      enrolled = await this.#registry.lookup(daemonId);
    } catch (cause) {
      return this.#refuse("unverifiable", `registry lookup failed: ${describe(cause)}`, { daemonId });
    }
    if (!enrolled) return this.#refuse("unknown_daemon", `no daemon enrolled as ${daemonId}`, { daemonId });

    let daemonInstance: string | null;
    try {
      daemonInstance = await this.#backplane.locateDaemon(daemonId);
    } catch (cause) {
      return this.#refuse("unverifiable", `routing lookup failed: ${describe(cause)}`, { daemonId });
    }
    if (daemonInstance === null) {
      return this.#refuse("daemon_offline", `${daemonId} is enrolled but not connected`, { daemonId });
    }

    const requestId = `wh_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url")}`;
    const secret = req.headers.get("x-webhook-secret") ?? querySecret ?? "";
    const body = Buffer.from(await req.arrayBuffer()).toString("base64url");
    const contentType = req.headers.get("content-type") ?? undefined;
    const deferred = Promise.withResolvers<Response>();
    this.#webhooks.set(requestId, { daemonId, resolve: deferred.resolve });

    try {
      const daemon = this.#daemons.get(daemonId);
      if (daemon && daemonInstance === this.instanceId) {
        this.#sendDaemon(daemon, { t: "webhook_request", requestId, routineId, secret, body, contentType });
      } else {
        await this.#backplane.send(daemonInstance, {
          k: "webhook_request",
          from: this.instanceId,
          daemonId,
          sessionId: requestId,
          requestId,
          routineId,
          secret,
          payload: body,
          contentType,
        });
      }

      const timeout = Promise.withResolvers<Response>();
      const timer = setTimeout(
        () => timeout.resolve(Response.json({ error: "daemon_timeout" }, { status: 504 })),
        WEBHOOK_TIMEOUT_MS,
      );
      try {
        return await Promise.race([deferred.promise, timeout.promise]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return Response.json({ error: "relay_broken" }, { status: 502 });
    } finally {
      this.#webhooks.delete(requestId);
    }
  }

  /**
   * Admit a client leg, or refuse it.
   *
   * The hub checks two things and no more: that the daemon is enrolled, and
   * that it is currently connected somewhere. It cannot check the client's
   * credential, because it holds nothing to check one against, and giving it
   * something would make the hub an authority on who may reach a machine it
   * only relays for. The daemon decides that, at the far end of a channel this
   * process cannot read.
   */
  async #upgradeClient(req: Request, server: Server<LegState>, daemonId: string): Promise<Response | undefined> {
    let enrolled: EnrolledDaemon | null;
    try {
      enrolled = await this.#registry.lookup(daemonId);
    } catch (cause) {
      // The registry is unreachable, so this hub cannot establish whether the
      // daemon is enrolled. Unverifiable is a refusal: admitting on the theory
      // that it probably is would make an outage into an open door.
      return this.#refuse("unverifiable", `registry lookup failed: ${describe(cause)}`, { daemonId });
    }
    if (!enrolled) return this.#refuse("unknown_daemon", `no daemon enrolled as ${daemonId}`, { daemonId });

    let daemonInstance: string | null;
    try {
      daemonInstance = await this.#backplane.locateDaemon(daemonId);
    } catch (cause) {
      // The routing table is unreachable, so this hub cannot establish where
      // the daemon is, or whether it is anywhere. An unverifiable answer is a
      // refusal; guessing would be the hub inventing a routing decision.
      return this.#refuse("unverifiable", `routing lookup failed: ${describe(cause)}`, { daemonId });
    }
    if (daemonInstance === null) {
      return this.#refuse("daemon_offline", `${daemonId} is enrolled but not connected`, { daemonId });
    }

    const sessionId = `s${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url")}`;
    const data: ClientLeg = {
      kind: "client",
      sessionId,
      daemonId,
      daemonInstance,
      sent: 0,
      acked: 0,
      behindSinceMs: null,
      expected: 0,
      received: 0,
      tokens: RATE_BURST,
      refilledAtMs: this.#now(),
    };
    if (!server.upgrade(req, { data })) return new Response("expected a websocket upgrade", { status: 426 });
    return undefined;
  }

  #refuse(code: RefusalCode, message: string, detail: Record<string, string>): Response {
    this.#audit({
      ts: new Date().toISOString(),
      action: "client.link",
      outcome: "denied",
      instanceId: this.instanceId,
      code,
      ...detail,
    });
    const status = code === "unknown_daemon" ? 404 : code === "daemon_offline" ? 503 : 502;
    return Response.json({ error: code, message }, { status });
  }

  async #enroll(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    if (!this.#operatorAuthorised(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    if (body === null || typeof body !== "object" || !("publicKey" in body) || !("label" in body)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const { publicKey, label } = body;
    if (typeof publicKey !== "string" || typeof label !== "string") {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }

    try {
      const row = await this.#registry.enroll({ publicKey, label });
      this.#audit({
        ts: new Date().toISOString(),
        action: "enroll.create",
        outcome: "ok",
        instanceId: this.instanceId,
        daemonId: row.daemonId,
        detail: { label: row.label },
      });
      return Response.json({ daemonId: row.daemonId, label: row.label, enrolledAt: row.enrolledAt });
    } catch (cause) {
      return Response.json({ error: "bad_request", message: describe(cause) }, { status: 400 });
    }
  }

  async #unenroll(req: Request, daemonId: string): Promise<Response> {
    if (req.method !== "DELETE") return Response.json({ error: "not_found" }, { status: 404 });
    if (!this.#operatorAuthorised(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

    const removed = await this.#registry.remove(daemonId);
    if (removed) {
      // Enrollment is what makes a daemon reachable, so withdrawing it has to
      // take effect now rather than whenever the daemon next reconnects.
      const held = this.#daemons.get(daemonId);
      if (held) held.close(4403, "enrollment withdrawn");
      this.#audit({
        ts: new Date().toISOString(),
        action: "enroll.remove",
        outcome: "ok",
        instanceId: this.instanceId,
        daemonId,
      });
    }
    return Response.json({ removed });
  }

  #operatorAuthorised(req: Request): boolean {
    // No configured token closes the route. An enrollment endpoint that is open
    // because nobody set a secret is the one failure mode worth ruling out by
    // construction.
    if (this.#operatorToken === undefined) return false;
    const header = req.headers.get("authorization");
    if (header?.startsWith("Bearer ") !== true) return false;
    const presented = Buffer.from(header.slice("Bearer ".length));
    const expected = Buffer.from(this.#operatorToken);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  // -- websocket -------------------------------------------------------------

  #open(ws: ServerWebSocket<LegState>): void {
    const leg = ws.data;
    if (leg.kind === "daemon") {
      this.#sendDaemon(ws, { t: "challenge", v: PROTOCOL_VERSION, nonce: leg.challenge ?? "" });
      return;
    }
    this.#clients.set(leg.sessionId, ws);
    void this.#openSession(ws, leg);
  }

  async #openSession(ws: ServerWebSocket<LegState>, leg: ClientLeg): Promise<void> {
    const enrolled = await this.#registry.lookup(leg.daemonId);
    if (!enrolled) {
      this.#sendClient(ws, { t: "refused", code: "unknown_daemon", message: "daemon is not enrolled" });
      ws.close(4404, "unknown daemon");
      return;
    }

    // The public key travels so the client can check it against the id it
    // pinned. Handing it over is safe precisely because it is checkable: a
    // client that gets a key which does not hash to its pinned id refuses.
    this.#sendClient(ws, {
      t: "linked",
      v: PROTOCOL_VERSION,
      sessionId: leg.sessionId,
      daemonId: leg.daemonId,
      publicKey: enrolled.publicKey,
    });

    await this.#backplane.send(leg.daemonInstance, {
      k: "open",
      sessionId: leg.sessionId,
      daemonId: leg.daemonId,
      from: this.instanceId,
    });
    this.#audit({
      ts: new Date().toISOString(),
      action: "client.link",
      outcome: "ok",
      instanceId: this.instanceId,
      daemonId: leg.daemonId,
      sessionId: leg.sessionId,
    });
  }

  async #message(ws: ServerWebSocket<LegState>, raw: string | Buffer): Promise<void> {
    const leg = ws.data;
    if (!this.#allow(leg)) {
      if (leg.kind === "client") {
        this.#sendClient(ws, { t: "refused", code: "rate_limited", message: "too many frames" });
      }
      ws.close(4429, "rate limited");
      return;
    }
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (leg.kind === "daemon") await this.#fromDaemon(ws, leg, text);
    else await this.#fromClient(ws, leg, text);
  }

  async #fromDaemon(ws: ServerWebSocket<LegState>, leg: DaemonLeg, text: string): Promise<void> {
    const frame = parseFrame<DaemonToHub>(text);
    if (!frame) return;

    if (leg.daemonId === null) {
      if (frame.t !== "register") {
        ws.close(4400, "registration must come first");
        return;
      }
      await this.#register(ws, leg, frame);
      return;
    }

    switch (frame.t) {
      case "data": {
        const session = this.#sessions.get(frame.sessionId);
        if (!session || session.daemonId !== leg.daemonId) return;
        if (frame.rseq !== session.expected) {
          await this.#tear(frame.sessionId, "relay_broken", `daemon frame ${frame.rseq} arrived out of order`);
          return;
        }
        session.expected++;
        session.received++;
        await this.#backplane.send(session.clientInstance, {
          k: "to_client",
          sessionId: frame.sessionId,
          from: this.instanceId,
          rseq: frame.rseq,
          payload: frame.payload,
        });
        return;
      }
      case "webhook_response": {
        const status = Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 ? frame.status : 502;
        const pending = this.#webhooks.get(frame.requestId);
        if (pending && pending.daemonId === leg.daemonId) {
          const headers = frame.contentType === undefined ? undefined : { "content-type": frame.contentType };
          pending.resolve(new Response(Buffer.from(frame.body, "base64url"), { status, headers }));
          return;
        }

        const origin = this.#webhookOrigins.get(frame.requestId);
        if (origin === undefined) return;
        this.#webhookOrigins.delete(frame.requestId);
        await this.#backplane.send(origin, {
          k: "webhook_response",
          sessionId: frame.requestId,
          from: this.instanceId,
          requestId: frame.requestId,
          status,
          payload: frame.body,
          contentType: frame.contentType,
        });
        return;
      }
      case "ack": {
        const session = this.#sessions.get(frame.sessionId);
        if (session) this.#applyAck(session, frame.received);
        return;
      }
      case "close":
        await this.#tear(frame.sessionId, frame.code === "done" ? "done" : frame.code, frame.message ?? "closed");
        return;
      case "pong":
      case "register":
        return;
    }
  }

  async #register(ws: ServerWebSocket<LegState>, leg: DaemonLeg, frame: DaemonToHub): Promise<void> {
    if (frame.t !== "register") return;
    const deny = (code: RefusalCode, message: string): void => {
      this.#audit({
        ts: new Date().toISOString(),
        action: "daemon.register",
        outcome: "denied",
        instanceId: this.instanceId,
        daemonId: typeof frame.daemonId === "string" ? frame.daemonId : undefined,
        code,
      });
      this.#sendDaemon(ws, { t: "refused", code, message });
      ws.close(4401, code);
    };

    if (frame.v !== PROTOCOL_VERSION) {
      deny("version_mismatch", `hub speaks v${PROTOCOL_VERSION}`);
      return;
    }
    if (typeof frame.daemonId !== "string" || typeof frame.sig !== "string") {
      deny("bad_request", "registration was malformed");
      return;
    }

    let enrolled: EnrolledDaemon | null;
    try {
      enrolled = await this.#registry.lookup(frame.daemonId);
    } catch (cause) {
      // The registry is unreachable. The hub cannot establish whether this
      // daemon is enrolled, and an unverifiable claim is refused rather than
      // provisionally admitted.
      deny("unverifiable", `registry lookup failed: ${describe(cause)}`);
      return;
    }
    if (!enrolled) {
      deny("unknown_daemon", "not enrolled with this hub");
      return;
    }

    // The signature is checked against the *enrolled* key, never against the
    // key the frame carried. Trusting the frame's own key would make
    // registration a matter of claiming an id and signing for yourself.
    const challenge = leg.challenge ?? "";
    const signed = new TextEncoder().encode(`${registrationLabel()}|${challenge}|${frame.daemonId}`);
    if (!verifyWith(enrolled.publicKey, signed, frame.sig)) {
      deny("unverifiable", "signature did not match the enrolled key");
      return;
    }

    leg.daemonId = frame.daemonId;
    leg.challenge = null;

    // A daemon reconnecting while an older leg is still held here replaces it.
    // Two legs for one daemon would split its sessions across both.
    this.#daemons.get(frame.daemonId)?.close(4409, "replaced by a newer connection");
    this.#daemons.set(frame.daemonId, ws);
    await this.#backplane.claimDaemon(frame.daemonId, LEASE_TTL_MS);

    this.#sendDaemon(ws, { t: "registered", daemonId: frame.daemonId, instanceId: this.instanceId });
    this.#audit({
      ts: new Date().toISOString(),
      action: "daemon.register",
      outcome: "ok",
      instanceId: this.instanceId,
      daemonId: frame.daemonId,
      detail: { label: enrolled.label },
    });
  }

  async #fromClient(ws: ServerWebSocket<LegState>, leg: ClientLeg, text: string): Promise<void> {
    const frame = parseFrame<ClientToHub>(text);
    if (!frame) return;

    switch (frame.t) {
      case "data": {
        if (frame.rseq !== leg.expected) {
          await this.#tearClient(leg, "relay_broken", `client frame ${frame.rseq} arrived out of order`);
          return;
        }
        leg.expected++;
        leg.received++;
        leg.sent++;
        if (leg.behindSinceMs === null) leg.behindSinceMs = this.#now();
        await this.#backplane.send(leg.daemonInstance, {
          k: "to_daemon",
          sessionId: leg.sessionId,
          from: this.instanceId,
          rseq: frame.rseq,
          payload: frame.payload,
        });
        return;
      }
      case "ack":
        await this.#backplane.send(leg.daemonInstance, {
          k: "ack",
          sessionId: leg.sessionId,
          from: this.instanceId,
          received: frame.received,
        });
        return;
      case "pong":
        return;
    }
  }

  // -- cross-instance --------------------------------------------------------

  #onEnvelope(envelope: RelayEnvelope): void {
    void this.#handleEnvelope(envelope);
  }

  async #handleEnvelope(envelope: RelayEnvelope): Promise<void> {
    switch (envelope.k) {
      case "open": {
        const daemon = envelope.daemonId === undefined ? undefined : this.#daemons.get(envelope.daemonId);
        if (!daemon || envelope.daemonId === undefined) {
          // The lease pointed here and the leg is gone: the daemon dropped in
          // the window between the lookup and this envelope. Say so rather than

          // leaving the client waiting on a session that will never open.
          await this.#backplane.send(envelope.from, {
            k: "close",
            sessionId: envelope.sessionId,
            from: this.instanceId,
            code: "daemon_offline",
            message: "daemon leg is no longer held here",
          });
          return;
        }
        this.#sessions.set(envelope.sessionId, {
          sessionId: envelope.sessionId,
          daemonId: envelope.daemonId,
          clientInstance: envelope.from,
          sent: 0,
          acked: 0,
          behindSinceMs: null,
          expected: 0,
          received: 0,
        });
        this.#sendDaemon(daemon, { t: "open", sessionId: envelope.sessionId });
        return;
      }
      case "webhook_request": {
        const daemon = envelope.daemonId === undefined ? undefined : this.#daemons.get(envelope.daemonId);
        if (!daemon || envelope.daemonId === undefined || envelope.requestId === undefined || envelope.routineId === undefined) {
          await this.#backplane.send(envelope.from, {
            k: "webhook_response",
            sessionId: envelope.requestId ?? envelope.sessionId,
            from: this.instanceId,
            requestId: envelope.requestId ?? envelope.sessionId,
            status: 503,
            payload: Buffer.from(JSON.stringify({ error: "daemon_offline" })).toString("base64url"),
            contentType: "application/json",
          });
          return;
        }
        this.#webhookOrigins.set(envelope.requestId, envelope.from);
        this.#sendDaemon(daemon, {
          t: "webhook_request",
          requestId: envelope.requestId,
          routineId: envelope.routineId,
          secret: envelope.secret ?? "",
          body: envelope.payload ?? "",
          contentType: envelope.contentType,
        });
        return;
      }

      case "webhook_response": {
        const requestId = envelope.requestId ?? envelope.sessionId;
        const pending = this.#webhooks.get(requestId);
        if (!pending) return;
        const status =
          Number.isInteger(envelope.status) && (envelope.status ?? 0) >= 100 && (envelope.status ?? 0) <= 599
            ? (envelope.status ?? 502)
            : 502;
        const headers = envelope.contentType === undefined ? undefined : { "content-type": envelope.contentType };
        pending.resolve(new Response(Buffer.from(envelope.payload ?? "", "base64url"), { status, headers }));
        return;
      }

      case "to_daemon": {
        const session = this.#sessions.get(envelope.sessionId);
        const daemon = session ? this.#daemons.get(session.daemonId) : undefined;
        if (!session || !daemon) return;
        session.sent++;
        if (session.behindSinceMs === null) session.behindSinceMs = this.#now();
        this.#sendDaemon(daemon, {
          t: "data",
          sessionId: envelope.sessionId,
          rseq: envelope.rseq ?? 0,
          payload: envelope.payload ?? "",
        });
        return;
      }

      case "to_client": {
        const ws = this.#clients.get(envelope.sessionId);
        if (!ws) return;
        const leg = ws.data;
        if (leg.kind !== "client") return;
        leg.sent++;
        if (leg.behindSinceMs === null) leg.behindSinceMs = this.#now();
        this.#sendClient(ws, { t: "data", rseq: envelope.rseq ?? 0, payload: envelope.payload ?? "" });
        return;
      }

      case "ack": {
        const session = this.#sessions.get(envelope.sessionId);
        if (session) {
          this.#applyAck(session, envelope.received ?? 0);
          return;
        }
        const ws = this.#clients.get(envelope.sessionId);
        if (ws && ws.data.kind === "client") this.#applyAck(ws.data, envelope.received ?? 0);
        return;
      }

      case "close": {
        const ws = this.#clients.get(envelope.sessionId);
        if (ws) {
          this.#sendClient(ws, { t: "peer_gone", reason: envelope.message ?? "session closed" });
          ws.close(4410, "peer gone");
          this.#clients.delete(envelope.sessionId);
        }
        const session = this.#sessions.get(envelope.sessionId);
        if (session) {
          const daemon = this.#daemons.get(session.daemonId);
          if (daemon) {
            this.#sendDaemon(daemon, {
              t: "close",
              sessionId: envelope.sessionId,
              code: "done",
              message: envelope.message ?? "client went away",
            });
          }
          this.#sessions.delete(envelope.sessionId);
        }
        return;
      }
    }
  }

  /**
   * The backplane dropped. Every session whose other leg is elsewhere is now
   * unreliable, so all of them go.
   */
  #onDisrupted(reason: string): void {
    this.#audit({
      ts: new Date().toISOString(),
      action: "session.torn",
      outcome: "error",
      instanceId: this.instanceId,
      code: "relay_broken",
      detail: { reason, sessions: this.#sessions.size + this.#clients.size },
    });
    for (const [sessionId, ws] of this.#clients) {
      this.#sendClient(ws, { t: "peer_gone", reason: "relay lost its routing connection" });
      ws.close(4503, "relay broken");
      this.#clients.delete(sessionId);
    }
    for (const [sessionId, session] of this.#sessions) {
      const daemon = this.#daemons.get(session.daemonId);
      if (daemon) this.#sendDaemon(daemon, { t: "close", sessionId, code: "relay_broken", message: reason });
      this.#sessions.delete(sessionId);
    }
  }

  // -- upkeep ----------------------------------------------------------------

  async #tick(): Promise<void> {
    for (const daemonId of this.#daemons.keys()) {
      let held = false;
      try {
        held = await this.#backplane.renewDaemon(daemonId, LEASE_TTL_MS);
      } catch {
        held = false;
      }
      // Losing the lease means another instance now holds this daemon, or the
      // routing table is gone. Either way this leg must stop claiming to be the
      // way to reach it.
      if (!held) this.#daemons.get(daemonId)?.close(4409, "presence lease lost");
    }

    const now = this.#now();
    for (const [sessionId, session] of this.#sessions) {
      if (this.#overdue(session, now)) {
        await this.#tear(sessionId, "relay_broken", "daemon side stopped acknowledging relayed frames");
      }
    }
    for (const ws of this.#clients.values()) {
      const leg = ws.data;
      if (leg.kind === "client" && this.#overdue(leg, now)) {
        await this.#tearClient(leg, "relay_broken", "client side stopped acknowledging relayed frames");
      }
    }
  }

  #overdue(leg: { sent: number; acked: number; behindSinceMs: number | null }, now: number): boolean {
    if (leg.acked >= leg.sent) return false;
    return leg.behindSinceMs !== null && now - leg.behindSinceMs > ACK_DEADLINE_MS;
  }

  #applyAck(leg: { sent: number; acked: number; behindSinceMs: number | null }, received: number): void {
    if (received > leg.acked) leg.acked = received;
    leg.behindSinceMs = leg.acked >= leg.sent ? null : this.#now();
  }

  /** Tear down a session whose daemon leg is here. */
  async #tear(sessionId: string, code: RefusalCode | "done", message: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    const daemon = this.#daemons.get(session.daemonId);
    if (daemon) this.#sendDaemon(daemon, { t: "close", sessionId, code, message });
    await this.#backplane.send(session.clientInstance, {
      k: "close",
      sessionId,
      from: this.instanceId,
      code,
      message,
    });
    this.#audit({
      ts: new Date().toISOString(),
      action: "session.torn",
      outcome: code === "done" ? "ok" : "error",
      instanceId: this.instanceId,
      daemonId: session.daemonId,
      sessionId,
      code,
      detail: { message },
    });
  }

  /** Tear down a session whose client leg is here. */
  async #tearClient(leg: ClientLeg, code: RefusalCode, message: string): Promise<void> {
    const ws = this.#clients.get(leg.sessionId);
    if (ws) {
      this.#sendClient(ws, { t: "refused", code, message });
      ws.close(4503, code);
      this.#clients.delete(leg.sessionId);
    }
    await this.#backplane.send(leg.daemonInstance, {
      k: "close",
      sessionId: leg.sessionId,
      from: this.instanceId,
      code,
      message,
    });
    this.#audit({
      ts: new Date().toISOString(),
      action: "session.torn",
      outcome: "error",
      instanceId: this.instanceId,
      daemonId: leg.daemonId,
      sessionId: leg.sessionId,
      code,
      detail: { message },
    });
  }

  async #close(ws: ServerWebSocket<LegState>): Promise<void> {
    const leg = ws.data;
    if (leg.kind === "daemon") {
      if (leg.daemonId === null) return;
      // Only drop the registry entry if this socket is still the one on record.
      // A replaced leg closing after its successor registered would otherwise
      // evict the live one.
      if (this.#daemons.get(leg.daemonId) === ws) {
        this.#daemons.delete(leg.daemonId);
        await this.#backplane.releaseDaemon(leg.daemonId);
      }
      this.#audit({
        ts: new Date().toISOString(),
        action: "daemon.disconnect",
        outcome: "ok",
        instanceId: this.instanceId,
        daemonId: leg.daemonId,
      });
      // Every session this daemon was serving is over. Telling each client is
      // what lets it reconnect and replay rather than wait on a dead stream.
      for (const [sessionId, session] of this.#sessions) {
        if (session.daemonId !== leg.daemonId) continue;
        this.#sessions.delete(sessionId);
        await this.#backplane.send(session.clientInstance, {
          k: "close",
          sessionId,
          from: this.instanceId,
          code: "daemon_offline",
          message: "daemon disconnected",
        });
      }
      return;
    }

    this.#clients.delete(leg.sessionId);
    await this.#backplane.send(leg.daemonInstance, {
      k: "close",
      sessionId: leg.sessionId,
      from: this.instanceId,
      code: "done",
      message: "client disconnected",
    });
    this.#audit({
      ts: new Date().toISOString(),
      action: "client.disconnect",
      outcome: "ok",
      instanceId: this.instanceId,
      daemonId: leg.daemonId,
      sessionId: leg.sessionId,
    });
  }

  #allow(leg: LegState): boolean {
    const now = this.#now();
    const elapsed = (now - leg.refilledAtMs) / 1000;
    leg.tokens = Math.min(RATE_BURST, leg.tokens + elapsed * RATE_PER_SECOND);
    leg.refilledAtMs = now;
    if (leg.tokens < 1) return false;
    leg.tokens -= 1;
    return true;
  }

  #sendDaemon(ws: ServerWebSocket<LegState>, frame: HubToDaemon): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket went away between an event firing and this send.
    }
  }

  #sendClient(ws: ServerWebSocket<LegState>, frame: HubToClient): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // As above.
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Universal-link origin registered by the native clients. A room id identifies
 * shared state but is not a credential: device pairing and room membership are
 * still checked by the daemon after the native app opens it.
 */
export const COLLAB_UNIVERSAL_LINK_ORIGIN = "https://my.ompd.sh";
const COLLAB_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export function isCollabRoomId(roomId: string): boolean {
  return COLLAB_ROOM_ID_PATTERN.test(roomId);
}

/** The `/collab` share target for native Universal Links and Android App Links. */
export function formatCollabJoinLink(roomId: string): string {
  if (!isCollabRoomId(roomId)) throw new Error("collab room id must be a 10 to 64 character base64url id");
  return `${COLLAB_UNIVERSAL_LINK_ORIGIN}/collab/${roomId}`;
}

/** Session ids the hub mints must satisfy what the handshake will accept. */
export function isRoutableSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}
