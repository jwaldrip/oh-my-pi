import { describe, expect, test } from "bun:test";
import { fromBase64Url, toBase64Url, utf8 } from "../src/bytes.ts";
import { ChannelError, SealedChannel } from "../src/channel.ts";
import {
  answerClientHandshake,
  beginClientHandshake,
  HandshakeError,
  handshakeTranscript,
} from "../src/handshake.ts";
import { fingerprint, generateIdentity, identityFromPrivate, keyMatchesId, signWith, verifyWith } from "../src/identity.ts";

const SESSION = "sess_abc123";

/** Run both halves and hand back a wired pair of channels. */
async function establish(opts: { pinnedId?: string; sessionId?: string } = {}) {
  const identity = generateIdentity();
  const sessionId = opts.sessionId ?? SESSION;
  const client = beginClientHandshake(opts.pinnedId ?? identity.daemonId);
  const daemon = await answerClientHandshake({
    hello: client.hello,
    sessionId,
    daemonId: identity.daemonId,
    privateKey: identity.privateKey,
  });
  const keys = await client.accept(daemon.auth, { sessionId, publicKey: identity.publicKey });
  return {
    identity,
    clientChannel: new SealedChannel(keys, "client"),
    daemonChannel: new SealedChannel(daemon.keys, "daemon"),
  };
}

describe("identity", () => {
  test("generate, sign, verify, and the id is the key's fingerprint", () => {
    const id = generateIdentity();
    const message = utf8("attest this");
    expect(verifyWith(id.publicKey, message, signWith(id.privateKey, message))).toBe(true);
    expect(fingerprint(id.publicKey)).toBe(id.daemonId);
    expect(id.daemonId).toMatch(/^dmn_[0-9a-f]{64}$/);
  });

  test("a persisted seed round-trips to the same id and still signs", () => {
    const id = generateIdentity();
    // What a daemon restart does: read one value off disk, rebuild the rest.
    const reloaded = identityFromPrivate(id.privateKey);
    expect(reloaded.daemonId).toBe(id.daemonId);
    expect(reloaded.publicKey).toBe(id.publicKey);
    const message = utf8("after a restart");
    expect(verifyWith(id.publicKey, message, signWith(reloaded.privateKey, message))).toBe(true);
  });

  test("a substituted key does not match the id it is offered under", () => {
    const real = generateIdentity();
    const impostor = generateIdentity();
    // The exact move a compromised hub would make: keep the id the client
    // asked for, swap in a key it holds the private half of.
    expect(keyMatchesId(real.daemonId, impostor.publicKey)).toBe(false);
    expect(keyMatchesId(real.daemonId, real.publicKey)).toBe(true);
  });

  test("a tampered message fails verification", () => {
    const id = generateIdentity();
    const sig = signWith(id.privateKey, utf8("original"));
    expect(verifyWith(id.publicKey, utf8("tampered"), sig)).toBe(false);
  });

  test("malformed input is a refusal, not an exception", () => {
    expect(keyMatchesId("dmn_00", "not-a-key")).toBe(false);
    expect(verifyWith("not-a-key", utf8("m"), "sig")).toBe(false);
    expect(() => fingerprint("short")).toThrow();
  });
});

describe("base64url", () => {
  test("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(fromBase64Url(toBase64Url(all))).toEqual(all);
  });

  test("round-trips every remainder, so both tails are exercised", () => {
    // 256 bytes leaves one byte over, so the test above only ever walks the
    // one-left tail. A two-byte tail is its own arm of the encoder and its own
    // way to lose the last character of a key on the wire.
    for (let length = 0; length <= 8; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const text = toBase64Url(bytes);
      expect(text).not.toContain("=");
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  test("encodes known vectors, not merely something it can read back", () => {
    // A round trip alone passes with any self-consistent alphabet. These pin
    // the output to base64url itself, including the two characters that differ
    // from standard base64.
    expect(toBase64Url(utf8("foobar"))).toBe("Zm9vYmFy");
    expect(toBase64Url(new Uint8Array([0xff, 0xef, 0xbf]))).toBe("_--_");
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(toBase64Url(new Uint8Array([0xfc]))).toBe("_A");
  });

  test("rejects padding, whitespace, and the non-url alphabet", () => {
    expect(fromBase64Url("AA==")).toBeNull();
    expect(fromBase64Url("A A")).toBeNull();
    expect(fromBase64Url("a+b/")).toBeNull();
  });
});

describe("handshake", () => {
  test("both sides reach the same key and can talk", async () => {
    const { clientChannel, daemonChannel } = await establish();
    const prompt = JSON.stringify({ t: "prompt", text: "hello" });
    expect(await daemonChannel.open(await clientChannel.seal(prompt))).toBe(prompt);
    expect(await clientChannel.open(await daemonChannel.seal("answer"))).toBe("answer");
  });

  test("the sealed payload does not contain the plaintext", async () => {
    const { clientChannel } = await establish();
    const sealed = await clientChannel.seal("swordfish");
    expect(sealed).not.toContain("swordfish");
  });

  test("a client pinned to a different daemon refuses the answer", async () => {
    const impostor = generateIdentity();
    await expect(establish({ pinnedId: impostor.daemonId })).rejects.toThrow(HandshakeError);
  });

  test("a daemon refuses a hello addressed to someone else", async () => {
    const real = generateIdentity();
    const other = generateIdentity();
    const client = beginClientHandshake(other.daemonId);
    await expect(
      answerClientHandshake({
        hello: client.hello,
        sessionId: SESSION,
        daemonId: real.daemonId,
        privateKey: real.privateKey,
      }),
    ).rejects.toThrow(/different daemon/);
  });

  test("a forged daemon signature is unverifiable", async () => {
    const real = generateIdentity();
    const impostor = generateIdentity();
    const client = beginClientHandshake(real.daemonId);
    // A hub holding no private half for `real` can still produce a well-formed
    // answer. It just cannot sign the transcript.
    const forged = await answerClientHandshake({
      hello: client.hello,
      sessionId: SESSION,
      daemonId: real.daemonId,
      privateKey: impostor.privateKey,
    });
    await expect(client.accept(forged.auth, { sessionId: SESSION, publicKey: real.publicKey })).rejects.toThrow(
      /did not prove possession/,
    );
  });

  test("a hub that rewrites the session id breaks the handshake", async () => {
    const identity = generateIdentity();
    const client = beginClientHandshake(identity.daemonId);
    const daemon = await answerClientHandshake({
      hello: client.hello,
      sessionId: "sess_real",
      daemonId: identity.daemonId,
      privateKey: identity.privateKey,
    });
    // The daemon signed a transcript over "sess_real". Telling the client
    // anything else invalidates the signature rather than silently diverging.
    await expect(
      client.accept(daemon.auth, { sessionId: "sess_forged", publicKey: identity.publicKey }),
    ).rejects.toThrow(HandshakeError);
  });

  test("a version the daemon does not speak is refused as a mismatch", async () => {
    const identity = generateIdentity();
    const client = beginClientHandshake(identity.daemonId);
    await expect(
      answerClientHandshake({
        hello: { ...client.hello, v: 99 },
        sessionId: SESSION,
        daemonId: identity.daemonId,
        privateKey: identity.privateKey,
      }),
    ).rejects.toMatchObject({ code: "version_mismatch" });
  });

  test("a malformed ephemeral key is refused rather than derived from", async () => {
    const identity = generateIdentity();
    const client = beginClientHandshake(identity.daemonId);
    await expect(
      answerClientHandshake({
        hello: { ...client.hello, eph: "short" },
        sessionId: SESSION,
        daemonId: identity.daemonId,
        privateKey: identity.privateKey,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("a session id outside the allowed alphabet is refused", async () => {
    const identity = generateIdentity();
    const client = beginClientHandshake(identity.daemonId);
    await expect(
      answerClientHandshake({
        hello: client.hello,
        sessionId: "sess|spliced",
        daemonId: identity.daemonId,
        privateKey: identity.privateKey,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("the transcript is unambiguous across field boundaries", () => {
    const base = {
      daemonId: `dmn_${"a".repeat(64)}`,
      sessionId: "s",
      clientNonce: "n1",
      clientEph: "e1",
      daemonNonce: "n2",
      daemonEph: "e2",
    };
    // Shifting a character across a boundary must not produce the same hash.
    // Joined with a separator instead of length-prefixed, these two collide.
    const shifted = { ...base, sessionId: "sn", clientNonce: "1" };
    expect(handshakeTranscript(base)).not.toEqual(handshakeTranscript(shifted));
  });
});

describe("sealed channel", () => {
  test("a replayed frame does not open twice", async () => {
    const { clientChannel, daemonChannel } = await establish();
    const sealed = await clientChannel.seal("once");
    expect(await daemonChannel.open(sealed)).toBe("once");
    await expect(daemonChannel.open(sealed)).rejects.toThrow(ChannelError);
  });

  test("a dropped frame breaks the channel rather than resyncing", async () => {
    const { clientChannel, daemonChannel } = await establish();
    await clientChannel.seal("dropped in transit");
    const second = await clientChannel.seal("arrives");
    // The receiver expects counter 0 and this is counter 1. Refusing is what
    // turns a silent loss into a torn session the relay can act on.
    await expect(daemonChannel.open(second)).rejects.toThrow(ChannelError);
  });

  test("a frame cannot be reflected back at its sender", async () => {
    const { clientChannel, daemonChannel } = await establish();
    const sealed = await clientChannel.seal("from the client");
    // Separate keys per direction: the client's own frame is not openable by
    // the client, so a relay cannot echo traffic back as though it were a reply.
    await expect(clientChannel.open(sealed)).rejects.toThrow(ChannelError);
    expect(await daemonChannel.open(sealed)).toBe("from the client");
  });

  test("frames sealed in the same tick arrive in order", async () => {
    const { clientChannel, daemonChannel } = await establish();
    // A daemon streaming two updates without awaiting between them. Sealing is
    // asynchronous, so without ordering inside the channel these finish in
    // whichever order the runtime completes them, reach the wire transposed,
    // and the far side refuses a stream that was never corrupted.
    const sealed = await Promise.all(["one", "two", "three", "four"].map((text) => clientChannel.seal(text)));
    const opened: string[] = [];
    for (const frame of sealed) opened.push(await daemonChannel.open(frame));
    expect(opened).toEqual(["one", "two", "three", "four"]);
  });

  test("frames opened in the same tick do not race for a counter", async () => {
    const { clientChannel, daemonChannel } = await establish();
    const sealed: string[] = [];
    for (const text of ["a", "b", "c"]) sealed.push(await clientChannel.seal(text));
    // Three arriving together, handled without awaiting between them.
    expect(await Promise.all(sealed.map((frame) => daemonChannel.open(frame)))).toEqual(["a", "b", "c"]);
  });

  test("a tampered ciphertext does not open", async () => {
    const { clientChannel, daemonChannel } = await establish();
    const raw = fromBase64Url(await clientChannel.seal("untouched"));
    if (raw === null) throw new Error("seal produced invalid base64url");
    raw[0] = (raw[0] as number) ^ 0xff;
    await expect(daemonChannel.open(toBase64Url(raw))).rejects.toThrow(ChannelError);
  });

  test("counts track what was actually sealed and opened", async () => {
    const { clientChannel, daemonChannel } = await establish();
    expect(clientChannel.sent).toBe(0);
    await daemonChannel.open(await clientChannel.seal("a"));
    await daemonChannel.open(await clientChannel.seal("b"));
    expect(clientChannel.sent).toBe(2);
    expect(daemonChannel.received).toBe(2);
  });
});
