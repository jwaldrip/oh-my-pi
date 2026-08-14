/**
 * Voice bridge tests.
 *
 * Everything here runs on synthetic PCM against fake subprocesses: no
 * microphone, no model download, no network. That is not a convenience, it is
 * what makes the tests mean anything. The interesting logic in the voice slice
 * is endpointing, buffer discipline, sanitising, and engine selection, and all
 * four are decided before a single audio sample reaches a speech binary.
 *
 * Each test is written to fail if the feature it covers were removed. Several
 * of them would pass trivially against a weaker implementation, so they are
 * paired with a negative case: the endpointer test asserts a mid-speech pause
 * does *not* fire, the selection tests assert the first available engine wins
 * rather than merely that some engine is returned, and the sanitiser test
 * asserts the code body is gone rather than only that the fence markers are.
 *
 * A live section at the bottom exercises the real engines on this machine. It
 * is gated behind OMPD_LIVE=1 because it depends on what is installed.
 */

import { describe, expect, test } from "bun:test";
import { SCOPE_PROMPT, SCOPE_READ, type Actor, type ServerFrame } from "@ompd/core";
import { UnauthorizedError } from "../src/supervisor.ts";
import {
  base64ToPcm,
  chunkFrames,
  decodeWav,
  detectUtteranceEnd,
  encodeWav,
  float32ToPcm,
  frameEnergy,
  loadSpeechRuntime,
  NullSttEngine,
  NullTtsEngine,
  OmpSttEngine,
  OmpTtsEngine,
  pcmToBase64,
  pcmToFloat32,
  selectSttEngine,
  selectTtsEngine,
  speakableSegments,
  STT_ENGINE_ORDER,
  SttUnavailableError,
  TTS_ENGINE_ORDER,
  TtsUnavailableError,
  VAD_DEFAULTS,
  VoiceBridge,
  VoiceBufferOverflowError,
  resamplePcm,
  WavFormatError,
  WIRE_SAMPLE_RATE,
  type CommandResult,
  type CommandRunner,
  type PcmAudio,
  type SttEngine,
  type TtsEngine,
} from "../src/voice/index.ts";

// The wire rate, taken from the bridge rather than restated, so a change to the
// contract fails here instead of silently disagreeing with it.
const RATE = WIRE_SAMPLE_RATE;
const AGENT = "agt_0123456789abcdef";
const speaker: Actor = { deviceId: "phone", scopes: [SCOPE_READ, SCOPE_PROMPT] };
const listener: Actor = { deviceId: "watcher", scopes: [SCOPE_READ] };

// ---------------------------------------------------------------------------
// synthetic audio
// ---------------------------------------------------------------------------

/** A tone at `amplitude` of full scale. RMS of a sine is amplitude / sqrt(2). */
function sine(ms: number, amplitude: number, freq = 220, rate = RATE): Int16Array {
  const count = Math.floor((rate * ms) / 1000);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return pcm;
}

function silence(ms: number, rate = RATE): Int16Array {
  return new Int16Array(Math.floor((rate * ms) / 1000));
}

function concat(...parts: Int16Array[]): Int16Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FakeProgram = (args: readonly string[]) => CommandResult;

/** A PATH and a set of programs, so engine selection is decided by the test. */
class FakeRunner implements CommandRunner {
  readonly calls: Array<{ bin: string; args: readonly string[] }> = [];
  #programs: Map<string, FakeProgram>;

  constructor(programs: Record<string, FakeProgram>) {
    this.#programs = new Map(Object.entries(programs));
  }

  which(bin: string): string | null {
    return this.#programs.has(bin) ? `/fake/bin/${bin}` : null;
  }

  async run(bin: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ bin, args });
    const program = this.#programs.get(bin);
    if (!program) return { code: 127, stdout: "", stderr: `${bin}: command not found` };
    return program(args);
  }
}

/**
 * A stand-in for OMP's `SttClient`.
 *
 * Structural, so the engine's real dependency is exercised without spawning
 * the ASR worker. Records what the engine actually handed the library, which
 * is where the Int16-to-float and resampling contract is observable.
 */
class FakeSttClient {
  readonly calls: Array<{ modelKey: string; samples: number; peak: number }> = [];
  #reply: string | Error;

  constructor(reply: string | Error) {
    this.#reply = reply;
  }

  async transcribe(modelKey: string, audio: Float32Array): Promise<string> {
    let peak = 0;
    for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
    this.calls.push({ modelKey, samples: audio.length, peak });
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

/**
 * A stand-in for OMP's `TtsClient`, rendering one chunk per pushed segment.
 *
 * `nativeRate` is a parameter because the wire-rate contract is only worth
 * anything if a test can drive an engine whose rate disagrees with the wire.
 */
class FakeTtsClient {
  readonly pushed: string[] = [];
  #nativeRate: number;

  constructor(nativeRate = 24_000) {
    this.#nativeRate = nativeRate;
  }

  synthesizeStream(_modelKey: string): {
    push: (text: string) => void;
    end: () => void;
    chunks: AsyncIterableIterator<{
      index: number;
      text: string;
      pcm: Float32Array;
      sampleRate: number;
    }>;
  } {
    const pushed = this.pushed;
    const rate = this.#nativeRate;
    const queue: string[] = [];
    let ended = false;

    async function* drain(): AsyncIterableIterator<{
      index: number;
      text: string;
      pcm: Float32Array;
      sampleRate: number;
    }> {
      let index = 0;
      while (queue.length > 0 || !ended) {
        const text = queue.shift();
        if (text === undefined) return;
        yield {
          index: index++,
          text,
          // 40ms of tone per segment, at the engine's own rate.
          pcm: pcmToFloat32(sine(40, 0.5, 440, rate)),
          sampleRate: rate,
        };
      }
    }

    return {
      push: (text: string) => {
        pushed.push(text);
        queue.push(text);
      },
      end: () => {
        ended = true;
      },
      chunks: drain(),
    };
  }
}

class ScriptedStt implements SttEngine {
  readonly name = "scripted";
  readonly received: Array<{ samples: number; sampleRate: number }> = [];
  #reply: string | Error;

  constructor(reply: string | Error) {
    this.#reply = reply;
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    this.received.push({ samples: pcm.length, sampleRate });
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

/**
 * A bridge-level fake engine: one audio chunk per segment, at a rate that
 * deliberately disagrees with the wire so resampling stays observable.
 */
class RecordingTts implements TtsEngine {
  readonly name = "recording";
  readonly received: string[] = [];
  readonly nativeRate: number;
  /** Samples emitted per segment, before the bridge resamples. */
  readonly chunkSamples: number;

  constructor(nativeRate = 24_000) {
    this.nativeRate = nativeRate;
    this.chunkSamples = Math.floor((nativeRate * 40) / 1000);
  }

  async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
    for (const segment of segments) {
      this.received.push(segment);
      yield { pcm: sine(40, 0.5, 440, this.nativeRate), sampleRate: this.nativeRate };
    }
  }
}

interface Harness {
  bridge: VoiceBridge;
  frames: ServerFrame[];
  transcripts: string[];
  stt: ScriptedStt;
  tts: RecordingTts;
}

function harness(
  opts: { stt?: ScriptedStt; maxBufferedSeconds?: number; nativeRate?: number } = {},
): Harness {
  const frames: ServerFrame[] = [];
  const transcripts: string[] = [];
  const stt = opts.stt ?? new ScriptedStt("run the tests");
  const tts = new RecordingTts(opts.nativeRate);
  const bridge = new VoiceBridge({
    send: (frame) => frames.push(frame),
    stt,
    tts,
    onTranscript: (_agentId, text) => {
      transcripts.push(text);
    },
    sampleRate: RATE,
    maxBufferedSeconds: opts.maxBufferedSeconds,
  });
  return { bridge, frames, transcripts, stt, tts };
}

/** Feed audio in 100ms packets, the way a browser recorder would. */
async function stream(bridge: VoiceBridge, pcm: Int16Array, actor: Actor = speaker): Promise<void> {
  const packet = RATE / 10;
  for (let offset = 0; offset < pcm.length; offset += packet) {
    await bridge.pushAudio(AGENT, pcmToBase64(pcm.subarray(offset, offset + packet)), actor);
  }
}

// ---------------------------------------------------------------------------
// endpointing
// ---------------------------------------------------------------------------

describe("vad", () => {
  test("energy separates a tone from silence by an order of magnitude", () => {
    expect(frameEnergy(silence(20))).toBe(0);
    // RMS of a 0.3 amplitude sine is 0.3/sqrt(2).
    expect(frameEnergy(sine(20, 0.3))).toBeCloseTo(0.212, 2);
    expect(frameEnergy(sine(20, 0.3))).toBeGreaterThan(VAD_DEFAULTS.speechThreshold);
  });

  test("fires once speech is followed by enough trailing silence", () => {
    const frames = chunkFrames(concat(sine(500, 0.3), silence(800)), RATE);
    expect(detectUtteranceEnd(frames)).toBe(true);
  });

  test("does not fire on a brief pause in the middle of speech", () => {
    // 300ms of quiet between two phrases, then only 100ms at the end: well
    // under the 700ms hangover, so the speaker still has the floor.
    const frames = chunkFrames(
      concat(sine(400, 0.3), silence(300), sine(400, 0.3), silence(100)),
      RATE,
    );
    expect(detectUtteranceEnd(frames)).toBe(false);
  });

  test("does not fire on silence that was never preceded by speech", () => {
    // An open microphone in a quiet room must not synthesise an utterance.
    expect(detectUtteranceEnd(chunkFrames(silence(5_000), RATE))).toBe(false);
  });

  test("does not fire when the speech was shorter than the minimum", () => {
    const frames = chunkFrames(concat(sine(40, 0.3), silence(1_000)), RATE);
    expect(detectUtteranceEnd(frames)).toBe(false);
  });

  test("hysteresis holds the floor through more between-threshold frames than the hangover", () => {
    // 0.02 amplitude sine has RMS ~0.0141: above silenceThreshold (0.01) and
    // below speechThreshold (0.02). Collapse the two thresholds into one and
    // every one of these frames becomes trailing silence, so the utterance
    // ends early and the speaker gets cut off mid-breath.
    const between = sine(1_000, 0.02);
    const betweenFrames = chunkFrames(between, RATE);
    expect(frameEnergy(betweenFrames[0] ?? new Int16Array(0))).toBeGreaterThan(
      VAD_DEFAULTS.silenceThreshold,
    );
    expect(frameEnergy(betweenFrames[0] ?? new Int16Array(0))).toBeLessThan(
      VAD_DEFAULTS.speechThreshold,
    );
    // The run must outlast the hangover, or the test would pass on length
    // alone rather than on the threshold that kept the floor.
    expect(betweenFrames.length).toBeGreaterThan(VAD_DEFAULTS.hangoverFrames);

    expect(detectUtteranceEnd(chunkFrames(concat(sine(300, 0.3), between), RATE))).toBe(false);
    // A frame that actually falls under the low threshold does end it, so the
    // case above is hysteresis and not a detector that never fires.
    expect(
      detectUtteranceEnd(chunkFrames(concat(sine(300, 0.3), between, silence(800)), RATE)),
    ).toBe(true);
    // The same level with no speech before it never enters speech at all.
    expect(detectUtteranceEnd(chunkFrames(concat(between, silence(1_000)), RATE))).toBe(false);
  });

  test("rejects an inverted hysteresis rather than silently reordering it", () => {
    expect(() => detectUtteranceEnd([], { speechThreshold: 0.01, silenceThreshold: 0.5 })).toThrow(
      RangeError,
    );
  });

  test("chunking drops only the trailing partial frame", () => {
    const frames = chunkFrames(silence(105), RATE);
    expect(frames.length).toBe(5);
    expect(frames[0]?.length).toBe(320);
  });
});

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

describe("wav and pcm framing", () => {
  test("base64 round trips PCM16 exactly", () => {
    const pcm = sine(30, 0.8);
    const back = base64ToPcm(pcmToBase64(pcm));
    expect(back.length).toBe(pcm.length);
    expect(back[0]).toBe(pcm[0] ?? 0);
    expect(back[100]).toBe(pcm[100] ?? 0);
    expect(back.at(-1)).toBe(pcm.at(-1) ?? 0);
  });

  test("wav round trips samples and rate", () => {
    const pcm = sine(25, 0.5, 440, 24_000);
    const decoded = decodeWav(encodeWav({ pcm, sampleRate: 24_000 }));
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.pcm.length).toBe(pcm.length);
    expect(decoded.pcm[10]).toBe(pcm[10] ?? 0);
  });

  test("decoding walks chunks instead of assuming a 44 byte header", () => {
    // Real encoders put LIST/fact chunks before data. Splice one in and the
    // fixed-offset shortcut reads metadata as audio.
    const original = encodeWav({ pcm: sine(20, 0.5), sampleRate: RATE });
    const listChunk = new Uint8Array(16);
    const listView = new DataView(listChunk.buffer);
    for (const [i, ch] of [..."LIST"].entries()) listView.setUint8(i, ch.charCodeAt(0));
    listView.setUint32(4, 8, true);
    for (const [i, ch] of [..."INFOxxxx"].entries()) listView.setUint8(8 + i, ch.charCodeAt(0));

    const spliced = new Uint8Array(original.length + listChunk.length);
    spliced.set(original.subarray(0, 36), 0);
    spliced.set(listChunk, 36);
    spliced.set(original.subarray(36), 36 + listChunk.length);
    new DataView(spliced.buffer).setUint32(4, spliced.length - 8, true);

    const decoded = decodeWav(spliced);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.pcm.length).toBe(320);
  });

  test("rejects bytes that are not RIFF/WAVE", () => {
    expect(() => decodeWav(new TextEncoder().encode("not audio at all!!"))).toThrow(WavFormatError);
  });

  test("rejects a PCM payload with a trailing half sample", () => {
    expect(() => base64ToPcm(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(WavFormatError);
  });
});

// ---------------------------------------------------------------------------
// sanitising
// ---------------------------------------------------------------------------

const ASSISTANT_TURN = [
  "# Results",
  "",
  "Ran the **suite**: 42 passing, see [the run](https://ci.example.com/runs/91)",
  "or https://ci.example.com/raw for the log.",
  "",
  "```ts",
  "const secret = computeTheAnswer(41 + 1);",
  "console.log(secret);",
  "```",
  "",
  "- Use `bun test` next",
  "- Docs: <https://docs.example.com>",
  "",
  "> Quoted advice here.",
].join("\n");

describe("speakableSegments", () => {
  test("removes code fences, their contents, url targets, and markdown syntax", () => {
    const spoken = speakableSegments(ASSISTANT_TURN).join(" ");

    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("computeTheAnswer");
    expect(spoken).not.toContain("console.log");
    // No scheme, no path, no query: a URL must never be read out as a slug.
    // The host survives as a spoken word, which is OMP's deliberate choice and
    // a change from the sanitiser this replaced. "see the docs at
    // ci.example.com" is useful; "h t t p s colon slash slash" is not.
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("://");
    expect(spoken).not.toContain("/runs/91");
    expect(spoken).not.toContain("/raw");
    expect(spoken).not.toContain("](");
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("#");
    expect(spoken).not.toContain("`");
    expect(spoken).not.toContain(">");

    expect(spoken).toContain("Results");
    expect(spoken).toContain("Ran the suite: 42 passing");
    expect(spoken).toContain("see the run");
    expect(spoken).toContain("Use bun test next");
    expect(spoken).toContain("Quoted advice here.");
  });

  test("a turn that is only a code fence has nothing to say", () => {
    const only = ["```bash", "rm -rf /tmp/x", "```"].join("\n");
    expect(speakableSegments(only)).toEqual([]);
  });

  test("a markdown table is not spoken", () => {
    // A behaviour change, not a bug fix. The sanitiser this replaced flattened
    // a table into "host, state, local, idle"; OMP's pipeline swallows any
    // line that starts with a pipe, on the grounds that a table read aloud is
    // noise. Adopting OMP's transform means adopting that judgement, so the
    // assertion says what actually happens rather than being deleted.
    const table = ["| host | state |", "| --- | --- |", "| local | idle |"].join("\n");
    expect(speakableSegments(table)).toEqual([]);
  });

  test("a multi-sentence reply becomes more than one segment", () => {
    // Load-bearing for streaming synthesis: an engine can only start speaking
    // early if there is an early segment to start on.
    const segments = speakableSegments(
      "The suite is green. Twelve tests passed on the first run. Nothing regressed.",
    );
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join(" ")).toContain("Twelve tests passed");
  });

  test("the bridge segments before the engine is called", () => {
    // The point of the whole exercise: the synthesiser must never see markdown.
    const { bridge, tts } = harness();
    return bridge.speak(AGENT, ASSISTANT_TURN).then((spoke) => {
      expect(spoke).toBe(true);
      // One segment per speakable unit, not one blob per turn. The old
      // assertion here was `toHaveLength(1)`, which encoded the one-shot
      // synthesis this change removes.
      expect(tts.received.length).toBeGreaterThan(1);
      for (const segment of tts.received) {
        expect(segment).not.toContain("```");
        expect(segment).not.toContain("console.log");
        expect(segment).not.toContain("https://");
      }
      expect(tts.received.join(" ")).toContain("42 passing");
    });
  });
});

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

describe("VoiceBridge", () => {
  test("transcribes on utterance end and emits a final transcript", async () => {
    const { bridge, frames, transcripts, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    const transcript = frames.find((f) => f.t === "transcript");
    expect(transcript).toEqual({ t: "transcript", agentId: AGENT, text: "run the tests", final: true });
    expect(transcripts).toEqual(["run the tests"]);
    expect(stt.received).toHaveLength(1);
    expect(stt.received[0]?.sampleRate).toBe(RATE);
    // The whole utterance reaches the engine: 400ms of speech plus the 700ms
    // hangover that closed it, and no more. Cutting at the hangover rather
    // than at end of stream is what makes the turn feel immediate.
    expect(stt.received[0]?.samples).toBeGreaterThanOrEqual(RATE * 1.1);
    expect(stt.received[0]?.samples).toBeLessThan(RATE * 1.25);
    // Audio after the cut belongs to the next utterance, not this one.
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(0.2, 2);
  });

  test("does not transcribe while the speaker is only pausing", async () => {
    const { bridge, frames, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(300), sine(400, 0.3), silence(100)));

    expect(stt.received).toHaveLength(0);
    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(1.2, 2);
  });

  test("audio_end flushes a buffer the endpointer has not closed", async () => {
    const { bridge, frames, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(100)));
    expect(stt.received).toHaveLength(0);

    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(1);
    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(1);
  });

  test("audio_end on an empty buffer is a no-op, not an empty transcript", async () => {
    const { bridge, frames, stt } = harness();
    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  test("a failed transcription becomes an error frame, never a silent drop", async () => {
    const { bridge, frames, transcripts } = harness({
      stt: new ScriptedStt(new SttUnavailableError("no speech-to-text engine is available")),
    });
    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(transcripts).toHaveLength(0);
    const error = frames.find((f) => f.t === "error");
    expect(error).toMatchObject({ t: "error", agentId: AGENT, code: "stt_failed" });
    expect(error && "message" in error ? error.message : "").toContain("no speech-to-text engine");
  });

  test("buffered audio is capped with an error instead of growing without bound", async () => {
    const { bridge, frames } = harness({ maxBufferedSeconds: 1 });
    const packet = pcmToBase64(silence(400));

    await bridge.pushAudio(AGENT, packet, speaker);
    await bridge.pushAudio(AGENT, packet, speaker);
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(0.8, 3);

    await expect(bridge.pushAudio(AGENT, packet, speaker)).rejects.toThrow(VoiceBufferOverflowError);
    // Dropped, not retained: the point of the cap is that memory comes back.
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    expect(frames.at(-1)).toMatchObject({ t: "error", code: "voice_buffer_overflow" });
  });

  test("an open microphone never grows the buffer past the cap", async () => {
    // Silence never triggers the endpointer, so this is the shape of the leak
    // the cap exists to prevent: a client that connected and walked away.
    const { bridge, frames } = harness({ maxBufferedSeconds: 1 });
    const packet = pcmToBase64(silence(400));
    let peak = 0;

    for (let i = 0; i < 30; i++) {
      await bridge.handleFrame({ t: "audio", agentId: AGENT, pcm: packet }, speaker);
      peak = Math.max(peak, bridge.bufferedSeconds(AGENT));
    }

    expect(peak).toBeLessThanOrEqual(1);
    expect(frames.filter((f) => f.t === "error" && f.code === "voice_buffer_overflow").length)
      .toBeGreaterThan(0);
  });

  test("audio from a device without prompt scope is refused", async () => {
    const { bridge, frames } = harness();
    await expect(
      bridge.pushAudio(AGENT, pcmToBase64(sine(100, 0.3)), listener),
    ).rejects.toThrow(UnauthorizedError);
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    expect(frames).toHaveLength(0);
  });

  test("handleFrame reports faults as frames rather than throwing at the socket", async () => {
    const { bridge, frames } = harness();
    await bridge.handleFrame({ t: "audio", agentId: AGENT, pcm: pcmToBase64(sine(100, 0.3)) }, listener);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "error", agentId: AGENT, code: "voice_error" });
    expect(frames[0] && "message" in frames[0] ? frames[0].message : "").toContain(SCOPE_PROMPT);
  });

  test("handleFrame ignores frames that belong to other subsystems", async () => {
    const { bridge, frames } = harness();
    await bridge.handleFrame({ t: "ping" }, speaker);
    await bridge.handleFrame({ t: "prompt", agentId: AGENT, text: "hi" }, speaker);
    expect(frames).toHaveLength(0);
  });

  test("speech is emitted as base64 PCM16 at the wire rate, not the engine's", async () => {
    // Kokoro renders at 24kHz and the wire is 16kHz, so the bridge resamples.
    // Asserting the engine's own length here would pass only while the two
    // rates happened to match, which is the bug this replaced.
    const { bridge, frames, tts } = harness();
    expect(await bridge.speak(AGENT, "Twelve tests passing.")).toBe(true);

    const speech = frames.find((f) => f.t === "speech");
    expect(speech).toBeDefined();

    const pcm = base64ToPcm(speech && "pcm" in speech ? speech.pcm : "");
    const expected = Math.round((tts.chunkSamples * WIRE_SAMPLE_RATE) / tts.nativeRate);
    // Within a sample: resampling rounds, and pinning an exact count would
    // make this test about the interpolator rather than the contract.
    expect(Math.abs(pcm.length - expected)).toBeLessThanOrEqual(1);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test.each([16_000, 22_050, 24_000, 48_000])(
    "an engine rendering at %iHz still puts 16kHz on the wire",
    async (nativeRate) => {
      // The rate is not carried in the frame, so a client decodes at 16kHz
      // whatever arrives. Length alone would pass for a resampler that dropped
      // samples, so the tone itself is measured: a 440Hz sine read at the wrong
      // rate reads back as a different pitch, which is exactly the "sounds like
      // a bad model" failure this guards.
      const { bridge, frames } = harness({ nativeRate });
      expect(await bridge.speak(AGENT, "Twelve tests passing.")).toBe(true);

      const speech = frames.find((f) => f.t === "speech");
      const pcm = base64ToPcm(speech && "pcm" in speech ? speech.pcm : "");

      // 40ms of audio at the wire rate, regardless of what the engine rendered.
      expect(Math.abs(pcm.length - 0.04 * WIRE_SAMPLE_RATE)).toBeLessThanOrEqual(1);

      let crossings = 0;
      for (let i = 1; i < pcm.length; i++) {
        if ((pcm[i - 1] ?? 0) < 0 !== ((pcm[i] ?? 0) < 0)) crossings++;
      }
      // Two zero crossings per cycle, interpreted at the wire rate.
      const hz = (crossings * WIRE_SAMPLE_RATE) / (2 * pcm.length);
      expect(hz).toBeGreaterThan(400);
      expect(hz).toBeLessThan(480);
    },
  );

  test("a multi-sentence reply is streamed as several speech frames", async () => {
    // The whole point of streaming synthesis: the client can start playing the
    // first clause while the rest is still being rendered. One frame per turn
    // would satisfy the wire contract and defeat the purpose.
    const { bridge, frames, tts } = harness();
    const reply = "The suite is green. Twelve tests passed on the first run. Nothing regressed.";
    expect(await bridge.speak(AGENT, reply)).toBe(true);

    const speech = frames.filter((f) => f.t === "speech");
    expect(speech.length).toBeGreaterThan(1);
    expect(speech.length).toBe(tts.received.length);
    // Every frame carries real audio; a stream of empties would also be
    // "several frames".
    for (const frame of speech) {
      expect(base64ToPcm("pcm" in frame ? frame.pcm : "").length).toBeGreaterThan(0);
    }
  });

  test("a synthesis failure part way through a reply becomes an error frame", async () => {
    // A stream can fail after it has already emitted, which a one-shot call
    // could not. The client must be told rather than left with half an answer
    // and no explanation.
    const frames: ServerFrame[] = [];
    const failing: TtsEngine = {
      name: "half-broken",
      async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
        let emitted = 0;
        for (const _segment of segments) {
          if (emitted === 1) throw new Error("vocoder died");
          emitted++;
          yield { pcm: sine(40, 0.5, 440, WIRE_SAMPLE_RATE), sampleRate: WIRE_SAMPLE_RATE };
        }
      },
    };
    const bridge = new VoiceBridge({
      send: (frame) => frames.push(frame),
      tts: failing,
      sampleRate: RATE,
    });

    expect(await bridge.speak(AGENT, "First sentence. Second sentence here.")).toBe(false);
    expect(frames.filter((f) => f.t === "speech")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ t: "error", agentId: AGENT, code: "tts_failed" });
  });

  test("a null tts engine reports rather than emitting silence", async () => {
    const frames: ServerFrame[] = [];
    const bridge = new VoiceBridge({
      send: (frame) => frames.push(frame),
      tts: new NullTtsEngine(["omp: text-to-speech model kokoro is not downloaded"]),
      sampleRate: RATE,
    });

    expect(await bridge.speak(AGENT, "Twelve tests passing.")).toBe(false);
    expect(frames.filter((f) => f.t === "speech")).toHaveLength(0);
    const error = frames.find((f) => f.t === "error");
    expect(error).toMatchObject({ t: "error", code: "tts_failed" });
    // Names the engine and the reason, so the operator knows what to fix.
    expect(error && "message" in error ? error.message : "").toContain("kokoro is not downloaded");
  });

  test("nothing is spoken and nothing is sent when a turn sanitises away", async () => {
    const { bridge, frames, tts } = harness();
    expect(await bridge.speak(AGENT, ["```sh", "ls -la", "```"].join("\n"))).toBe(false);
    expect(tts.received).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  test("a failing prompt is reported as a prompt failure, not as a failure to hear", async () => {
    // Regression: both calls once shared a try block, so a supervisor that
    // refused the prompt was reported to the client as `stt_failed`. That
    // sends the operator to their microphone to fix a transcription that
    // was perfect.
    const frames: ServerFrame[] = [];
    const bridge = new VoiceBridge({
      send: (frame) => frames.push(frame),
      stt: new ScriptedStt("run the tests"),
      sampleRate: RATE,
      onTranscript: () => {
        throw new Error("unknown agent");
      },
    });

    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    const transcript = frames.find((f) => f.t === "transcript");
    expect(transcript).toBeDefined();
    expect(transcript && "text" in transcript ? transcript.text : "").toBe("run the tests");

    const error = frames.find((f) => f.t === "error");
    expect(error && "code" in error ? error.code : "").toBe("voice_prompt_failed");
    expect(error && "message" in error ? error.message : "").toBe("unknown agent");

    // Order matters: the client must see the text it said before the failure
    // of what that text became.
    expect(frames.indexOf(transcript as ServerFrame)).toBeLessThan(
      frames.indexOf(error as ServerFrame),
    );
  });

  test("a socket that fails mid-transcript does not wedge the agent forever", async () => {
    // Regression: the re-entrancy guard was once released by two hand-placed
    // deletes rather than one finally, and `#send` sat between them. A socket
    // that threw while delivering the transcript left the guard set, and from
    // then on every utterance for that agent hit the guard and vanished. A
    // dropped connection is routine, so this was permanent silent loss.
    const stt = new ScriptedStt("first utterance");
    let failNextSend = true;
    const delivered: ServerFrame[] = [];
    const bridge = new VoiceBridge({
      send: (frame) => {
        if (frame.t === "transcript" && failNextSend) {
          failNextSend = false;
          throw new Error("socket closed");
        }
        delivered.push(frame);
      },
      stt,
      sampleRate: RATE,
    });

    // The gateway calls this from a socket message handler, so it must absorb
    // the send failure rather than turn it into an unhandled rejection.
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );
    expect(stt.received).toHaveLength(1);

    // The channel still works: a second utterance is heard and delivered.
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );
    expect(stt.received).toHaveLength(2);
    expect(delivered.filter((f) => f.t === "transcript")).toHaveLength(1);
  });

  test("reset discards an utterance without transcribing it", async () => {
    const { bridge, stt } = harness();
    await stream(bridge, sine(400, 0.3));
    expect(bridge.bufferedSeconds(AGENT)).toBeGreaterThan(0);

    bridge.reset(AGENT);
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(0);
  });

  test("engines in use are reportable", () => {
    const bridge = new VoiceBridge({ send: () => {} });
    expect(bridge.engines()).toEqual({ stt: "null", tts: "null" });
  });
});

// ---------------------------------------------------------------------------
// null engines
// ---------------------------------------------------------------------------

describe("null engines", () => {
  test("NullSttEngine throws instead of returning empty text", async () => {
    const engine = new NullSttEngine(["omp: model not downloaded"]);
    const attempt = engine.transcribe(sine(200, 0.3), RATE);

    await expect(attempt).rejects.toThrow(SttUnavailableError);
    await expect(attempt).rejects.toThrow(/model not downloaded/);
    // The failure mode this guards: resolving to "" and looking like silence.
    await expect(attempt).rejects.not.toBe("");
  });

  test("NullSttEngine with no reasons still explains itself", async () => {
    await expect(new NullSttEngine().transcribe(sine(50, 0.3), RATE)).rejects.toThrow(
      /no speech-to-text engine is configured/,
    );
  });

  test("a bridge with no engines configured errors on audio rather than swallowing it", async () => {
    const frames: ServerFrame[] = [];
    const bridge = new VoiceBridge({ send: (f) => frames.push(f), sampleRate: RATE });
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );

    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(frames.find((f) => f.t === "error")).toMatchObject({ code: "stt_failed" });
  });

  test("NullTtsEngine throws rather than emitting empty audio", async () => {
    const engine = new NullTtsEngine(["omp: kokoro is not downloaded"]);
    const pull = async (): Promise<void> => {
      for await (const _chunk of engine.stream(["hello"])) break;
    };
    await expect(pull()).rejects.toThrow(TtsUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// engine selection
// ---------------------------------------------------------------------------

describe("engine selection", () => {
  test("stt takes omp when the ASR weights are on disk", async () => {
    const engine = await selectSttEngine({ omp: { isModelCached: async () => true } });
    expect(engine.name).toBe("omp");
    expect(STT_ENGINE_ORDER.indexOf(engine.name)).toBe(0);
  });

  test("stt declines, naming the engine and the model, when the weights are absent", async () => {
    // The honest failure. An operator reading this has to be able to tell
    // "not downloaded" from "broken", and to know which command fixes it.
    const engine = await selectSttEngine({ omp: { isModelCached: async () => false } });

    expect(engine.name).toBe("null");
    expect(STT_ENGINE_ORDER.indexOf(engine.name)).toBe(STT_ENGINE_ORDER.length - 1);
    const reasons = (engine as NullSttEngine).reasons().join(" ");
    expect(reasons).toContain("omp");
    expect(reasons).toContain("parakeet");
    expect(reasons).toContain("not downloaded");
    expect(reasons).toContain("omp setup speech");
  });

  test("a cache check that throws is reported, not treated as a missing model", async () => {
    // A permission error on the cache directory is a different problem from an
    // undownloaded model, and telling the operator to run a download that will
    // also fail wastes their time.
    const engine = await selectSttEngine({
      omp: {
        isModelCached: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    expect((engine as NullSttEngine).reasons().join(" ")).toContain("EACCES");
  });

  test("the omp stt engine hands the library normalised 16kHz float audio", async () => {
    // The conversion contract with OMP's worker: Int16 in, Float32 at 16kHz
    // out. Getting the scale wrong transcribes silence; getting the rate wrong
    // transcribes a chipmunk.
    const client = new FakeSttClient("open the pod bay doors");
    const engine = new OmpSttEngine({ client, isModelCached: async () => true });

    expect(await engine.transcribe(sine(200, 0.5, 220, RATE), RATE)).toBe(
      "open the pod bay doors",
    );
    const call = client.calls[0];
    expect(call?.modelKey).toBe("parakeet");
    expect(call?.samples).toBe(Math.floor(RATE * 0.2));
    // A 0.5 amplitude sine peaks at half of full scale once normalised.
    expect(call?.peak).toBeGreaterThan(0.45);
    expect(call?.peak).toBeLessThanOrEqual(1);
  });

  test("audio recorded off the wire rate is resampled before the library sees it", async () => {
    const client = new FakeSttClient("hello");
    const engine = new OmpSttEngine({ client, isModelCached: async () => true });

    await engine.transcribe(sine(200, 0.5, 220, 48_000), 48_000);
    // 200ms at 16kHz, not the 9600 samples that arrived.
    expect(client.calls[0]?.samples).toBe(3_200);
  });

  test("a worker failure names the engine rather than leaking its own vocabulary", async () => {
    const client = new FakeSttClient(new Error("worker exited with code 1"));
    const engine = new OmpSttEngine({ client, isModelCached: async () => true });

    const attempt = engine.transcribe(sine(200, 0.3), RATE);
    await expect(attempt).rejects.toThrow(SttUnavailableError);
    await expect(attempt).rejects.toThrow(/omp parakeet could not transcribe/);
    await expect(attempt).rejects.toThrow(/worker exited with code 1/);
  });

  test("tts prefers omp over the OS voice", async () => {
    const engine = await selectTtsEngine({
      omp: { isModelCached: async () => true, isRuntimeCached: async () => true },
      say: { platform: "darwin" },
      runner: new FakeRunner({ say: () => ({ code: 0, stdout: "", stderr: "" }) }),
    });
    expect(engine.name).toBe("omp");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(0);
  });

  test("tts falls back to macOS say when omp has no voice model", async () => {
    const engine = await selectTtsEngine({
      omp: { isModelCached: async () => false, isRuntimeCached: async () => true },
      say: { platform: "darwin" },
      runner: new FakeRunner({ say: () => ({ code: 0, stdout: "", stderr: "" }) }),
    });
    expect(engine.name).toBe("say");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(1);
  });

  test("tts reports a missing runtime separately from missing weights", async () => {
    // Two independent failures with the same remedy but different diagnoses.
    // Collapsing them sends the operator looking for a model that is present.
    const engine = await selectTtsEngine({
      omp: { isModelCached: async () => true, isRuntimeCached: async () => false },
      say: { platform: "linux" },
      runner: new FakeRunner({}),
    });
    expect(engine.name).toBe("null");
    expect((engine as NullTtsEngine).reasons().join(" ")).toContain("kokoro runtime is not installed");
  });

  test("tts does not take a non-Apple binary that happens to be called say", async () => {
    const engine = await selectTtsEngine({
      omp: { isModelCached: async () => false, isRuntimeCached: async () => false },
      say: { platform: "linux" },
      runner: new FakeRunner({ say: () => ({ code: 0, stdout: "", stderr: "" }) }),
    });
    expect(engine.name).toBe("null");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(TTS_ENGINE_ORDER.length - 1);
  });

  test("the omp tts engine pushes every segment and yields a chunk for each", async () => {
    const client = new FakeTtsClient(24_000);
    const engine = new OmpTtsEngine({
      client,
      isModelCached: async () => true,
      isRuntimeCached: async () => true,
    });

    const chunks: PcmAudio[] = [];
    for await (const chunk of engine.stream(["First sentence.", "Second one."])) {
      chunks.push(chunk);
    }

    expect(client.pushed).toEqual(["First sentence.", "Second one."]);
    expect(chunks).toHaveLength(2);
    // Float back to PCM16 without losing the waveform.
    expect(chunks[0]?.sampleRate).toBe(24_000);
    expect(chunks[0]?.pcm.length).toBe(Math.floor(24_000 * 0.04));
  });
});

// ---------------------------------------------------------------------------
// pcm conversion
// ---------------------------------------------------------------------------

describe("float and pcm conversion", () => {
  test("round trips every extreme of the Int16 range exactly", () => {
    // The two scales have to be the same, or full scale drifts by a sample on
    // every pass through the speech stack.
    const pcm = new Int16Array([-32_768, -32_767, -1, 0, 1, 32_766, 32_767]);
    expect(Array.from(float32ToPcm(pcmToFloat32(pcm)))).toEqual(Array.from(pcm));
  });

  test("clamps a vocoder overshoot instead of wrapping it", () => {
    // Wrapping turns an overshoot into a full-scale click, which is far more
    // audible than the clipping it came from.
    const out = float32ToPcm(new Float32Array([1.5, -1.5]));
    expect(out[0]).toBe(32_767);
    expect(out[1]).toBe(-32_768);
  });
});

// ---------------------------------------------------------------------------
// speech runtime
// ---------------------------------------------------------------------------

describe("speech runtime loading", () => {
  test("both engines get one shared outcome rather than a different one each", async () => {
    // Regression. The engines used to import OMP's speech modules
    // independently, and when that graph fails to initialise the half-evaluated
    // modules stay in the loader cache: whichever engine imported second got a
    // temporal-dead-zone artifact from inside upstream instead of the real
    // cause. Measured on a machine with no native addon built, the first engine
    // reported "Failed to load pi_natives native addon" and the second reported
    // "Cannot access 'compiledTemplateCache' before initialization", which is
    // an error an operator cannot act on and cannot trace back to the truth.
    //
    // Memoising the load is what makes the answer the same for both. Asserting
    // identity rather than an error string keeps this meaningful on a machine
    // where the runtime does load.
    const first = loadSpeechRuntime();
    const second = loadSpeechRuntime();
    expect(first).toBe(second);

    const settle = async (p: Promise<unknown>): Promise<string> => {
      try {
        return `ok:${typeof (await p)}`;
      } catch (err) {
        return `err:${err instanceof Error ? err.message : String(err)}`;
      }
    };
    expect(await settle(first)).toBe(await settle(second));
  });

  test("engine probes agree on whether the runtime is reachable", async () => {
    // The observable consequence of the above: two engines asked in sequence
    // must not disagree about the machine they are both running on.
    const stt = await new OmpSttEngine().probe();
    const tts = await new OmpTtsEngine().probe();

    const unreachable = (reason: string): boolean =>
      reason.includes("could not reach its speech runtime");
    expect(unreachable(stt.reason)).toBe(unreachable(tts.reason));
  });
});

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

/**
 * Against the real models on this machine. Gated because the answer depends on
 * what has been downloaded, which is exactly what makes it worth running by
 * hand before trusting a deployment.
 */
const live = process.env.OMPD_LIVE === "1" ? describe : describe.skip;

live("live engines", () => {
  test("selection reports what this machine can actually do", async () => {
    const log: string[] = [];
    const stt = await selectSttEngine({ onLog: (line) => log.push(line) });
    const tts = await selectTtsEngine({ onLog: (line) => log.push(line) });

    expect(STT_ENGINE_ORDER).toContain(stt.name);
    expect(TTS_ENGINE_ORDER).toContain(tts.name);
    expect(log).toHaveLength(2);
  });

  test("the resolved tts engine streams real audio the wire can carry", async () => {
    const engine = await selectTtsEngine();
    const segments = speakableSegments("Twelve **tests** passing. Nothing regressed.");
    if (engine.name === "null") {
      const pull = async (): Promise<void> => {
        for await (const _chunk of engine.stream(segments)) break;
      };
      await expect(pull()).rejects.toThrow(TtsUnavailableError);
      return;
    }

    const chunks: PcmAudio[] = [];
    for await (const chunk of engine.stream(segments)) chunks.push(chunk);

    // More than one segment in, more than one chunk out: streaming for real.
    expect(segments.length).toBeGreaterThan(1);
    expect(chunks.length).toBe(segments.length);
    for (const chunk of chunks) {
      expect(chunk.pcm.length).toBeGreaterThan(0);
      expect(chunk.sampleRate).toBeGreaterThan(8_000);
      expect(base64ToPcm(pcmToBase64(chunk.pcm)).length).toBe(chunk.pcm.length);
    }
  }, 180_000);

  test("the resolved stt engine transcribes what the tts engine just said", async () => {
    const stt = await selectSttEngine();
    const tts = await selectTtsEngine();
    if (stt.name === "null" || tts.name === "null") return;

    const parts: Int16Array[] = [];
    for await (const chunk of tts.stream(["The quick brown fox jumps over the lazy dog."])) {
      parts.push(resamplePcm(chunk, RATE).pcm);
    }
    const transcript = await stt.transcribe(concat(...parts), RATE);
    expect(transcript.toLowerCase()).toContain("quick brown fox");
  }, 300_000);
});
