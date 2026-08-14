/**
 * Byte plumbing, written to run anywhere.
 *
 * This package is imported by the daemon (Bun), the hub (Bun), and the phone
 * and browser clients (React Native and the web). `Buffer` exists in exactly
 * one of those, so none of it is used here. Base64url is hand-rolled for the
 * same reason: `btoa`/`atob` need a polyfill on React Native and get the
 * URL-safe alphabet wrong anyway.
 */

/**
 * The alphabet, indexed with `charAt` rather than `[]` throughout.
 *
 * A six-bit group is 0..63 and this string is exactly 64 characters, so the
 * lookup cannot miss. `[]` says otherwise under `noUncheckedIndexedAccess`,
 * which leaves two ways out: assert the result is a string at each of the nine
 * call sites, or use the accessor whose return type is already `string`. The
 * second keeps the impossible case impossible rather than asserted away.
 */
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse table, built once. -1 marks a byte that is not in the alphabet. */
const B64URL_REVERSE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) table[B64URL.charCodeAt(i)] = i;
  return table;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64URL.charAt((n >>> 18) & 63) +
      B64URL.charAt((n >>> 12) & 63) +
      B64URL.charAt((n >>> 6) & 63) +
      B64URL.charAt(n & 63);
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL.charAt((n >>> 18) & 63) + B64URL.charAt((n >>> 12) & 63);
  } else if (left === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL.charAt((n >>> 18) & 63) + B64URL.charAt((n >>> 12) & 63) + B64URL.charAt((n >>> 6) & 63);
  }
  return out;
}

/**
 * Decode base64url, or null.
 *
 * Strict: padding, whitespace, and any character outside the URL-safe alphabet
 * are all a null rather than a best effort. Everything decoded here came off a
 * wire, and a lenient decoder is how two parties end up disagreeing about what
 * the same string meant.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  const len = text.length;
  if (len % 4 === 1) return null;
  const outLen = ((len * 3) / 4) | 0;
  const out = new Uint8Array(outLen);

  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (B64URL_REVERSE[code] as number) : -1;
    if (value < 0) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, or the encoder emitted a character whose low
  // bits carried information that decoding just dropped.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return o === outLen ? out : out.subarray(0, o);
}

/** Decode base64url and require an exact length. Null on either failure. */
export function fromBase64UrlExact(text: string, length: number): Uint8Array | null {
  const raw = fromBase64Url(text);
  return raw !== null && raw.length === length ? raw : null;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The same bytes, typed as something WebCrypto will accept.
 *
 * `Uint8Array` defaults to `Uint8Array<ArrayBufferLike>`, which includes a
 * `SharedArrayBuffer` backing, and `BufferSource` does not. Under Bun's types
 * that difference never surfaces; under the DOM lib the app compiles against
 * it rejects every `crypto.subtle` call in this package. The bytes here are
 * always `ArrayBuffer`-backed at runtime, so the common path is a cast with no
 * copy, and the shared-memory case is copied rather than asserted away.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Encode fields so no two different field lists can produce the same bytes.
 *
 * A transcript joined with a separator is only unambiguous while every field is
 * guaranteed not to contain the separator, and one of the fields here is a
 * session id chosen by the hub, which is the party this protocol does not
 * trust. Length-prefixing removes the guarantee from the threat model: the
 * boundaries are stated rather than inferred.
 */
export function canonical(fields: readonly (string | Uint8Array)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const field of fields) {
    const bytes = typeof field === "string" ? utf8(field) : field;
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, bytes.length, false);
    chunks.push(header, bytes);
  }
  return concat(chunks);
}

/**
 * Compare two byte strings without revealing where they first differ.
 *
 * A length mismatch returns early, which leaks only the length. Every caller
 * compares values whose length is fixed by the protocol.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
