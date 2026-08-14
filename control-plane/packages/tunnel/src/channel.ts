/**
 * The sealed channel between a client and a daemon.
 *
 * Everything of substance rides inside this. The hub relays base64 and holds no
 * key that opens it, which is the only reason a public relay can be allowed to
 * broker access to machines that execute code.
 *
 * Two properties are worth being explicit about.
 *
 * **Direction has its own key.** Rather than separating the two flows by a bit
 * in the nonce, each gets a key of its own from HKDF. Nonce reuse across
 * directions then cannot happen by construction, and a frame captured in one
 * direction cannot be reflected back in the other.
 *
 * **Position is authenticated.** The counter is the nonce and also goes in the
 * additional data, and the receiver expects the exact next one. Reorder,
 * replay, and drop are then the same refusal, which is what lets the relay
 * treat any of them as a torn session rather than papering over one.
 */

import { bufferSource, fromBase64Url, toBase64Url, utf8 } from "./bytes.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const KEY_BITS = 256;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Ceiling on frames per direction per session.
 *
 * Far below what the counter could reach and far above any real session. A
 * channel that hits it is refused rather than wrapped, because a wrapped
 * counter is a repeated nonce, and a repeated nonce in GCM is a lost key.
 */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type ChannelRole = "client" | "daemon";

/** Thrown when a frame does not authenticate. Always fatal to the session. */
export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface ChannelKeys {
  /** Client to daemon. */
  readonly c2d: CryptoKey;
  /** Daemon to client. */
  readonly d2c: CryptoKey;
}

/**
 * Derive both directions from the ECDH secret and the handshake transcript.
 *
 * The transcript is the salt, so every field either party contributed is bound
 * into the key. A hub that altered any of them, including the daemon id it
 * claimed to be routing to, produces a different key on each side and the first
 * sealed frame fails to open.
 */
export async function deriveChannelKeys(sharedSecret: Uint8Array, transcript: Uint8Array): Promise<ChannelKeys> {
  const ikm = await crypto.subtle.importKey("raw", bufferSource(sharedSecret), "HKDF", false, ["deriveBits"]);
  const derive = async (label: string): Promise<CryptoKey> => {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: bufferSource(transcript), info: bufferSource(utf8(label)) },
      ikm,
      KEY_BITS,
    );
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  };
  return {
    c2d: await derive(`ompd-tunnel-c2d-v${PROTOCOL_VERSION}`),
    d2c: await derive(`ompd-tunnel-d2c-v${PROTOCOL_VERSION}`),
  };
}

export class SealedChannel {
  readonly #sendKey: CryptoKey;
  readonly #recvKey: CryptoKey;
  #sendCounter = 0;
  #recvCounter = 0;

  /**
   * Serialises each direction.
   *
   * WebCrypto is asynchronous, so two overlapping calls would take their
   * counters in call order and then finish in whatever order the runtime
   * happened to complete them. The caller writes on completion, so the frames
   * reach the wire transposed and the far side, which requires the exact next
   * counter, refuses a stream that was never actually corrupted.
   *
   * A daemon streaming two updates in the same tick is enough to hit it, so
   * ordering belongs here rather than in each caller: the counter lives in this
   * object, and so should the guarantee that it is honoured.
   */
  #sendChain: Promise<unknown> = Promise.resolve();
  #recvChain: Promise<unknown> = Promise.resolve();

  constructor(keys: ChannelKeys, role: ChannelRole) {
    this.#sendKey = role === "client" ? keys.c2d : keys.d2c;
    this.#recvKey = role === "client" ? keys.d2c : keys.c2d;
  }

  /** Frames sealed so far. The relay uses this as its cumulative send count. */
  get sent(): number {
    return this.#sendCounter;
  }

  /** Frames opened so far. The relay reports this as its cumulative ack. */
  get received(): number {
    return this.#recvCounter;
  }

  seal(plaintext: string): Promise<string> {
    const sealed = this.#sendChain.then(() => this.#sealNow(plaintext));
    // Swallow on the chain itself so one failure does not reject every later
    // call; the caller still sees its own rejection through `sealed`.
    this.#sendChain = sealed.catch(() => {});
    return sealed;
  }

  open(sealed: string): Promise<string> {
    const opened = this.#recvChain.then(() => this.#openNow(sealed));
    this.#recvChain = opened.catch(() => {});
    return opened;
  }

  async #sealNow(plaintext: string): Promise<string> {
    if (this.#sendCounter >= MAX_COUNTER) throw new ChannelError("channel exhausted");
    const counter = this.#sendCounter++;
    const sealed = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(nonceFor(counter)),
        additionalData: bufferSource(aadFor(counter)),
        tagLength: TAG_BYTES * 8,
      },
      this.#sendKey,
      bufferSource(utf8(plaintext)),
    );
    return toBase64Url(new Uint8Array(sealed));
  }

  async #openNow(sealed: string): Promise<string> {
    const raw = fromBase64Url(sealed);
    if (raw === null || raw.length < TAG_BYTES) throw new ChannelError("sealed frame was malformed");

    const counter = this.#recvCounter;
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bufferSource(nonceFor(counter)),
          additionalData: bufferSource(aadFor(counter)),
          tagLength: TAG_BYTES * 8,
        },
        this.#recvKey,
        bufferSource(raw),
      );
    } catch {
      // Indistinguishable on purpose: a forged tag, a replayed frame, and a
      // frame the relay dropped all land here, and the session is over either
      // way. Saying which would tell an attacker whether the counter was the
      // part that was wrong.
      throw new ChannelError("sealed frame did not authenticate");
    }

    this.#recvCounter++;
    return new TextDecoder().decode(plaintext);
  }
}

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(NONCE_BYTES - 8, BigInt(counter), false);
  return nonce;
}

function aadFor(counter: number): Uint8Array {
  return utf8(`v${PROTOCOL_VERSION}|${counter}`);
}
