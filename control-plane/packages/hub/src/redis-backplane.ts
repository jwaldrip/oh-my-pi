/**
 * The backplane Cloud Run actually runs on.
 *
 * Two connections, because a Redis connection in subscribe mode cannot issue
 * ordinary commands. One publishes and holds the presence leases, the other
 * does nothing but listen on this instance's channel.
 *
 * Leases are compare-and-set on renew and compare-and-delete on release, both
 * as scripts so the check and the write cannot be separated by another
 * instance's write. Without that, an instance whose lease had already been
 * taken over by a reconnecting daemon would renew or delete the new holder's
 * entry, and the daemon would become unroutable while looking perfectly
 * healthy.
 *
 * A daemon reconnecting to a different instance overwrites the lease outright.
 * That is deliberate: the daemon's live socket is the truth about where it is,
 * and the previous holder finds out when its next renew returns false.
 */

import { RedisClient } from "bun";
import type { Backplane, DisruptionHandler, EnvelopeHandler, RelayEnvelope } from "./backplane.ts";

const LEASE_PREFIX = "ompd:hub:daemon:";
const CHANNEL_PREFIX = "ompd:hub:inst:";

/** Extend only if this instance still holds it. */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

/** Delete only if this instance still holds it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export interface RedisBackplaneOptions {
  url: string;
  instanceId: string;
}

/**
 * Narrows an unknown thrown/rejected value to Bun's specific "the socket
 * closed while this was in flight" RedisError, the one documented shape of
 * teardown noise `close()` deliberately swallows. Anything else keeps
 * surfacing.
 */
function isRedisConnectionClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (!("code" in err)) return false;
  return err.code === "ERR_REDIS_CONNECTION_CLOSED";
}

export class RedisBackplane implements Backplane {
  readonly instanceId: string;
  readonly #commands: RedisClient;
  readonly #subscriber: RedisClient;
  #onEnvelope: EnvelopeHandler | undefined;
  #onDisrupted: DisruptionHandler | undefined;
  #closing = false;

  private constructor(opts: RedisBackplaneOptions, commands: RedisClient, subscriber: RedisClient) {
    this.instanceId = opts.instanceId;
    this.#commands = commands;
    this.#subscriber = subscriber;
  }

  static async connect(opts: RedisBackplaneOptions): Promise<RedisBackplane> {
    const commands = new RedisClient(opts.url);
    const subscriber = new RedisClient(opts.url);
    await commands.connect();
    await subscriber.connect();
    const backplane = new RedisBackplane(opts, commands, subscriber);

    await subscriber.subscribe(CHANNEL_PREFIX + opts.instanceId, (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (parsed !== null && typeof parsed === "object" && "k" in parsed) {
        backplane.#onEnvelope?.(parsed as RelayEnvelope);
      }
    });

    // Only the subscriber's silent death represents a routing hole (see
    // below): the commands client carries no standing state to lose, so its
    // close is unremarkable. But Bun's RedisClient reports every close
    // through this hook whether or not a handler is attached, and an
    // unhandled one surfaces as an unhandled error between test runs rather
    // than anything either `close()`'s try/catch or the caller can observe.
    // A handler -- even a no-op one -- is what makes that reporting land
    // somewhere instead of nowhere.
    commands.onclose = () => {};

    // The window this closes: the process is alive and holding both websockets
    // while its subscriber connection is not. Envelopes addressed here vanish
    // with nothing to notice, so both legs of every cross-instance session
    // would sit there looking connected. Reporting it is what turns a silent
    // hole into a teardown and a resume.
    subscriber.onclose = (error) => {
      if (backplane.#closing) return;
      backplane.#onDisrupted?.(`backplane subscriber closed: ${error instanceof Error ? error.message : error}`);
    };

    return backplane;
  }

  /**
   * Every operation is a no-op once closed.
   *
   * Shutting down a hub closes its websockets, and their close handlers report
   * the departure through here. Those run after `stop` has begun, so without
   * this they issue commands against a client that is being torn down and the
   * abort surfaces as an unhandled rejection. A closed backplane routes
   * nothing, which is the honest answer rather than an error.
   */
  async claimDaemon(daemonId: string, ttlMs: number): Promise<void> {
    if (this.#closing) return;
    await this.#commands.send("SET", [LEASE_PREFIX + daemonId, this.instanceId, "PX", String(ttlMs)]);
  }

  async renewDaemon(daemonId: string, ttlMs: number): Promise<boolean> {
    if (this.#closing) return false;
    const result = await this.#commands.send("EVAL", [
      RENEW_SCRIPT,
      "1",
      LEASE_PREFIX + daemonId,
      this.instanceId,
      String(ttlMs),
    ]);
    return Number(result) === 1;
  }

  async releaseDaemon(daemonId: string): Promise<void> {
    if (this.#closing) return;
    await this.#commands.send("EVAL", [RELEASE_SCRIPT, "1", LEASE_PREFIX + daemonId, this.instanceId]);
  }

  async locateDaemon(daemonId: string): Promise<string | null> {
    if (this.#closing) return null;
    return await this.#commands.get(LEASE_PREFIX + daemonId);
  }

  async send(instanceId: string, envelope: RelayEnvelope): Promise<void> {
    if (this.#closing) return;
    await this.#commands.publish(CHANNEL_PREFIX + instanceId, JSON.stringify(envelope));
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.#onEnvelope = handler;
  }

  onDisrupted(handler: DisruptionHandler): void {
    this.#onDisrupted = handler;
  }

  /**
   * Idempotent. The hub closes its backplane on shutdown and an owner may
   * close it again; a second close must not be an error, and closing an
   * already-closed client throws.
   */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    // Unsubscribe before closing. `close()` aborts whatever the client still
    // has in flight, and an active subscription is exactly that: the abort
    // surfaces as an unhandled rejection rather than an exception this could
    // catch, so the subscription has to be wound down first.
    try {
      await this.#subscriber.unsubscribe(CHANNEL_PREFIX + this.instanceId);
    } catch {
      // Already gone, which is the state this was trying to reach.
    }

    // Closing a client can still abort something in flight underneath it
    // (the socket teardown itself, or a command whose response was already
    // in transit), and that abort is the same kind of unhandled rejection
    // as the subscription's above -- surfacing after this function's own
    // try/catch has nothing left to run, not inside it. A narrow, temporary
    // process-level handler is the only place that is observable at all.
    // Scoped to teardown and to this one documented error so a genuinely
    // unrelated failure during close is still reported, not hidden.
    const swallowTeardownAbort = (err: unknown): void => {
      if (isRedisConnectionClosedError(err)) return;
      console.error("unexpected error while closing the redis backplane:", err);
    };
    process.on("unhandledRejection", swallowTeardownAbort);
    try {
      for (const client of [this.#subscriber, this.#commands]) {
        try {
          client.close();
        } catch {
          // Already closed. Nothing to release and nothing to report.
        }
      }
      // A closed socket's in-flight abort rejects on a later tick than the
      // synchronous `close()` call above, so the handler must still be
      // installed when that tick runs rather than being torn down with it.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", swallowTeardownAbort);
    }
  }
}
