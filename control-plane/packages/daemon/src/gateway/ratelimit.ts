/**
 * Per-socket token bucket.
 *
 * A paired device is trusted, not unlimited. A client stuck in a reconnect loop,
 * or a compromised one replaying frames, must not be able to saturate the
 * daemon for every other client. Burst is generous because a legitimate
 * reattach after a dropped connection sends a short flurry of frames.
 */

export interface TokenBucketOptions {
  /** Frames absorbable in one burst. */
  capacity: number;
  /** Steady-state frames per second. */
  refillPerSecond: number;
  /** Clock seam, so a test does not have to sleep to observe refill. */
  now?: () => number;
}

export class TokenBucket {
  #capacity: number;
  #refillPerSecond: number;
  #now: () => number;
  #tokens: number;
  #lastMs: number;

  constructor(opts: TokenBucketOptions) {
    this.#capacity = opts.capacity;
    this.#refillPerSecond = opts.refillPerSecond;
    this.#now = opts.now ?? Date.now;
    this.#tokens = opts.capacity;
    this.#lastMs = this.#now();
  }

  /** Consume one token. False means the caller is over budget right now. */
  take(): boolean {
    const now = this.#now();
    const elapsedSeconds = (now - this.#lastMs) / 1000;
    if (elapsedSeconds > 0) {
      const refilled = this.#tokens + elapsedSeconds * this.#refillPerSecond;
      this.#tokens = refilled > this.#capacity ? this.#capacity : refilled;
      this.#lastMs = now;
    }
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
