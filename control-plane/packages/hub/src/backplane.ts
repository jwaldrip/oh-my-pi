/**
 * Cross-instance routing.
 *
 * The hub runs on Cloud Run, so two legs of one session routinely land on two
 * different instances: a daemon's websocket is held by instance A while the
 * phone that wants it connects to instance B. Nothing in a single process can
 * fix that, and session affinity on Cloud Run is best-effort, which is another
 * way of saying it is not a correctness mechanism. So the routing table lives
 * outside the process and instances address each other through it.
 *
 * Two things travel here: **presence**, which says which instance currently
 * holds a given daemon's leg, and **envelopes**, which are frames addressed to
 * whichever instance holds the other leg.
 *
 * Presence is a lease, not a registration. An instance that is killed mid-flight
 * writes no goodbye, so anything permanent would leave a daemon looking reachable
 * at an address that no longer exists. A lease that has to be renewed decays on
 * its own, and the daemon reconnecting rebuilds it. That is the whole answer to
 * "no sticky in-memory state it cannot rebuild": there is no state here that
 * outliving its owner would corrupt.
 *
 * ## Why this is not a durable queue
 *
 * Frames are relayed, never stored. A queue would mean a prompt could be
 * delivered to a daemon after the session that authorised it had already been
 * torn down, and "a work order that runs later when nobody is watching" is the
 * exact failure `docs/fleet.md` refuses for field-agent. Loss is instead made
 * *detectable*: envelopes carry a per-session sequence, the receiver requires
 * the next one, and a gap tears the session down so the client reconnects and
 * replays with `sinceSeq` against the daemon's durable update log. A tail frame,
 * which no later sequence would ever reveal, is caught by the cumulative
 * acknowledgement instead.
 */

export type EnvelopeKind =
  | "open"
  | "to_daemon"
  | "to_client"
  | "close"
  | "ack"
  | "webhook_request"
  | "webhook_response";

/**
 * One hop between hub instances.
 *
 * Flat and small on purpose: this is serialised onto a wire that is not the
 * session's confidential channel, so `payload` is the only substantial field
 * and it is already sealed before it gets here.
 */
export interface RelayEnvelope {
  readonly k: EnvelopeKind;
  readonly sessionId: string;
  /** Instance that sent this, and where the reply goes. */
  readonly from: string;
  readonly daemonId?: string;
  /** Per-session, per-direction counter. A gap means the relay lost something. */
  readonly rseq?: number;
  readonly payload?: string;
  readonly code?: string;
  readonly message?: string;
  /** Cumulative count the sender has actually taken in, for `ack`. */
  readonly received?: number;
  readonly requestId?: string;
  readonly routineId?: string;
  readonly secret?: string;
  readonly status?: number;
  readonly contentType?: string;
}

export type EnvelopeHandler = (envelope: RelayEnvelope) => void;

/**
 * Raised when the backplane's own connection dropped.
 *
 * Not recoverable in place: while it was down, envelopes addressed to this
 * instance went nowhere and there is no log to read them back from. Every
 * cross-instance session this instance holds must be torn down so both ends
 * reconnect and resume from the daemon's update log.
 */
export type DisruptionHandler = (reason: string) => void;

export interface Backplane {
  /** Stable for the life of this process. */
  readonly instanceId: string;
  /** Record that this instance holds `daemonId`'s leg, for `ttlMs`. */
  claimDaemon(daemonId: string, ttlMs: number): Promise<void>;
  /** Extend the claim. False means it was lost, and the caller must stop serving. */
  renewDaemon(daemonId: string, ttlMs: number): Promise<boolean>;
  releaseDaemon(daemonId: string): Promise<void>;
  /** Which instance holds that daemon, or null. */
  locateDaemon(daemonId: string): Promise<string | null>;
  send(instanceId: string, envelope: RelayEnvelope): Promise<void>;
  onEnvelope(handler: EnvelopeHandler): void;
  onDisrupted(handler: DisruptionHandler): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-process
// ---------------------------------------------------------------------------

/**
 * The shared medium two in-process hubs talk over.
 *
 * Exists so a test can run two real `Hub` objects against one routing table and
 * exercise the cross-instance path, which is the path production runs on and
 * the one a single-process test would never touch.
 */
export class MemoryBus {
  readonly #leases = new Map<string, { instanceId: string; expiresAtMs: number }>();
  readonly #inboxes = new Map<string, EnvelopeHandler>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  attach(instanceId: string, handler: EnvelopeHandler): void {
    this.#inboxes.set(instanceId, handler);
  }

  detach(instanceId: string): void {
    this.#inboxes.delete(instanceId);
  }

  claim(daemonId: string, instanceId: string, ttlMs: number): void {
    this.#leases.set(daemonId, { instanceId, expiresAtMs: this.#now() + ttlMs });
  }

  renew(daemonId: string, instanceId: string, ttlMs: number): boolean {
    const lease = this.#leases.get(daemonId);
    if (!lease || lease.instanceId !== instanceId) return false;
    lease.expiresAtMs = this.#now() + ttlMs;
    return true;
  }

  release(daemonId: string, instanceId: string): void {
    // Only the holder may release. Otherwise an instance whose lease was already
    // taken over would evict the daemon's real, current location on its way out.
    if (this.#leases.get(daemonId)?.instanceId === instanceId) this.#leases.delete(daemonId);
  }

  locate(daemonId: string): string | null {
    const lease = this.#leases.get(daemonId);
    if (!lease) return null;
    if (lease.expiresAtMs <= this.#now()) {
      this.#leases.delete(daemonId);
      return null;
    }
    return lease.instanceId;
  }

  deliver(instanceId: string, envelope: RelayEnvelope): void {
    // A missing inbox is a hub instance that has gone. Dropping is correct: the
    // session it belonged to is already unreachable, and the sender's ack
    // deadline is what turns that into a teardown.
    this.#inboxes.get(instanceId)?.(envelope);
  }
}

export class MemoryBackplane implements Backplane {
  readonly instanceId: string;
  readonly #bus: MemoryBus;
  #onDisrupted: DisruptionHandler | undefined;

  constructor(bus: MemoryBus, instanceId: string) {
    this.#bus = bus;
    this.instanceId = instanceId;
  }

  async claimDaemon(daemonId: string, ttlMs: number): Promise<void> {
    this.#bus.claim(daemonId, this.instanceId, ttlMs);
  }

  async renewDaemon(daemonId: string, ttlMs: number): Promise<boolean> {
    return this.#bus.renew(daemonId, this.instanceId, ttlMs);
  }

  async releaseDaemon(daemonId: string): Promise<void> {
    this.#bus.release(daemonId, this.instanceId);
  }

  async locateDaemon(daemonId: string): Promise<string | null> {
    return this.#bus.locate(daemonId);
  }

  async send(instanceId: string, envelope: RelayEnvelope): Promise<void> {
    this.#bus.deliver(instanceId, envelope);
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.#bus.attach(this.instanceId, handler);
  }

  onDisrupted(handler: DisruptionHandler): void {
    this.#onDisrupted = handler;
  }

  /** Test seam: simulate the backplane connection dropping. */
  disrupt(reason: string): void {
    this.#onDisrupted?.(reason);
  }

  async close(): Promise<void> {
    this.#bus.detach(this.instanceId);
  }
}
