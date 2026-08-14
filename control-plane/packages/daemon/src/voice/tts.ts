/**
 * Text to speech.
 *
 * OMP runs Kokoro-82M on device through a warm worker, and now that the control
 * plane lives inside the fork it can drive that worker directly instead of
 * shelling out to `omp say` and waiting for a file to appear.
 *
 * The interface is a stream, not a call. A spoken reply is segmented before
 * anything is synthesised, and each segment's audio is handed back the moment
 * it is rendered, so the first words leave for the client while the rest of the
 * sentence is still in the vocoder. One-shot synthesis makes a phone wait for
 * the slowest part of a paragraph before it hears the fastest.
 *
 * Turning markdown into speakable prose is not done here either. OMP's
 * `SpeakableStream` is the real implementation of that and it is the same one
 * the TUI speaks through, so the daemon and the terminal say the same words.
 */

// Only the segmenter and the model registry are imported eagerly: both are pure
// TypeScript. Everything that reaches the native speech runtime goes through
// `loadSpeechRuntime`, which explains why.
import {
  DEFAULT_TTS_LOCAL_MODEL_KEY,
  type TtsLocalModelKey,
} from "@oh-my-pi/pi-coding-agent/tts/models";
import { SpeakableStream } from "@oh-my-pi/pi-coding-agent/tts/speakable";
import { loadSpeechRuntime, type TtsSynthesizer } from "./speech-runtime.ts";
import {
  BunCommandRunner,
  withScratchDir,
  type CommandRunner,
  type EngineAvailability,
} from "./exec.ts";
import { decodeWav, float32ToPcm, type PcmAudio } from "./wav.ts";

/**
 * Speakable segments in, rendered audio out, in emission order.
 *
 * An async iterable rather than a promise of the whole utterance: that shape is
 * the entire reason a reply can start playing before it is finished. An engine
 * that can only render one shot at a time still satisfies it by yielding once
 * per segment, which is already a real improvement over one blob per turn.
 */
export interface TtsEngine {
  /** Selection slot, one of `TTS_ENGINE_ORDER`. */
  readonly name: string;
  stream(segments: Iterable<string>): AsyncIterable<PcmAudio>;
}

export class TtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsUnavailableError";
  }
}

/** The order `selectTtsEngine` tries. Local neural voice first, OS voice as the floor. */
export const TTS_ENGINE_ORDER: readonly string[] = ["omp", "say", "null"];

const DEFAULT_TTS_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// speakable
// ---------------------------------------------------------------------------

/**
 * Run OMP's markdown-to-speech transform over a finished turn.
 *
 * `SpeakableStream` is built for deltas arriving from a live generation; a
 * completed turn is the degenerate case of one delta followed by a flush. The
 * result is the same segment list the TUI would speak, which is the point:
 * there is now one definition of what an assistant turn sounds like.
 *
 * An empty array means nothing in the turn was worth vocalizing. That is a
 * real answer, not a failure, and callers are expected to stay silent on it.
 */
export function speakableSegments(text: string): string[] {
  const stream = new SpeakableStream();
  const segments = stream.push(text);
  segments.push(...stream.flush());
  return segments;
}

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

/**
 * A structural type rather than OMP's class, so a test can substitute a fake
 * without spawning the worker subprocess. `TtsClient` satisfies it as written.
 */
export type { TtsSynthesizer };

export interface OmpTtsOptions {
  /** Defaults to OMP's process-wide warm client. */
  client?: TtsSynthesizer;
  /** Kokoro voice id. Omitted means the model's default voice. */
  voice?: string;
  /** Local TTS model key. Defaults to `kokoro`. */
  modelKey?: TtsLocalModelKey;
  /**
   * Whether the model weights are on disk. Defaults to OMP's own cache check;
   * injectable so a probe test does not depend on what this machine downloaded.
   */
  isModelCached?: (key: string) => Promise<boolean>;
  /**
   * Whether the Kokoro runtime is installed. Separate from the weights because
   * they fail independently and the operator fixes them with different commands.
   */
  isRuntimeCached?: () => Promise<boolean>;
}

/**
 * Streaming synthesis on OMP's warm Kokoro worker.
 *
 * Segments are pushed as fast as they are available and audio is consumed as it
 * is produced, so the worker is rendering segment two while segment one is
 * already on its way to the client.
 */
export class OmpTtsEngine implements TtsEngine {
  readonly name = "omp";

  #client: TtsSynthesizer | undefined;
  #voice: string | undefined;
  #modelKey: TtsLocalModelKey;
  #isModelCached: ((key: string) => Promise<boolean>) | undefined;
  #isRuntimeCached: (() => Promise<boolean>) | undefined;
  #probed: EngineAvailability | null = null;

  constructor(opts: OmpTtsOptions = {}) {
    this.#client = opts.client;
    this.#voice = opts.voice;
    this.#modelKey = opts.modelKey ?? DEFAULT_TTS_LOCAL_MODEL_KEY;
    this.#isModelCached = opts.isModelCached;
    this.#isRuntimeCached = opts.isRuntimeCached;
  }

  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = await this.#runProbe();
    return this.#probed;
  }

  async #runProbe(): Promise<EngineAvailability> {
    try {
      // The runtime is loaded only when something is still missing, so a fully
      // injected engine never touches the native stack, and a real one shares
      // the single load the STT engine also reports from.
      let runtimeReady = this.#isRuntimeCached;
      let modelReady = this.#isModelCached;
      if (runtimeReady === undefined || modelReady === undefined) {
        const runtime = await loadSpeechRuntime();
        runtimeReady ??= runtime.isTtsRuntimeCached;
        modelReady ??= runtime.isTtsModelCached;
      }

      if (!(await runtimeReady())) {
        return {
          available: false,
          reason: "omp kokoro runtime is not installed; run `omp setup speech`",
        };
      }
      if (!(await modelReady(this.#modelKey))) {
        return {
          available: false,
          reason: `omp text-to-speech model ${this.#modelKey} is not downloaded; run \`omp setup speech\``,
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { available: false, reason: `omp could not reach its speech runtime: ${detail}` };
    }
    return { available: true, reason: `omp ${this.#modelKey} on the local TTS worker` };
  }

  async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
    const probe = await this.probe();
    if (!probe.available) throw new TtsUnavailableError(probe.reason);

    this.#client ??= (await loadSpeechRuntime()).ttsClient;
    const handle = this.#client.synthesizeStream(
      this.#modelKey,
      this.#voice === undefined ? {} : { voice: this.#voice },
    );
    // Pushed before the first chunk is awaited, so the worker has the whole
    // queue and never idles between segments waiting to be fed.
    for (const segment of segments) handle.push(segment);
    handle.end();

    for await (const chunk of handle.chunks) {
      if (chunk.pcm.length === 0) continue;
      yield { pcm: float32ToPcm(chunk.pcm), sampleRate: chunk.sampleRate };
    }
  }
}

// ---------------------------------------------------------------------------
// macOS say
// ---------------------------------------------------------------------------

/**
 * `say -o out.wav` writes AIFF unless told otherwise, so the data format is
 * pinned. LEI16 is little-endian signed 16-bit, which is the wire format
 * already, and 22050Hz is what the system voices are sampled at.
 */
const SAY_DATA_FORMAT = "LEI16@22050";

export interface SayTtsOptions {
  runner?: CommandRunner;
  binary?: string;
  /** System voice name, e.g. Samantha. Omitted means the user's default. */
  voice?: string;
  /** Defaults to `process.platform`. Injectable so selection tests do not depend on the host OS. */
  platform?: string;
  timeoutMs?: number;
}

/**
 * The OS voice, one invocation per segment.
 *
 * `say` has no streaming mode, so this is a loop rather than a pipeline. It
 * still satisfies the streaming contract in the way that matters: the first
 * sentence reaches the client while the second is still being rendered.
 */
export class SayTtsEngine implements TtsEngine {
  readonly name = "say";

  #runner: CommandRunner;
  #binary: string;
  #voice: string | undefined;
  #platform: string;
  #timeoutMs: number;
  #probed: EngineAvailability | null = null;

  constructor(opts: SayTtsOptions = {}) {
    this.#runner = opts.runner ?? new BunCommandRunner();
    this.#binary = opts.binary ?? "say";
    this.#voice = opts.voice;
    this.#platform = opts.platform ?? process.platform;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  }

  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = this.#runProbe();
    return this.#probed;
  }

  #runProbe(): EngineAvailability {
    // Linux has unrelated binaries named `say`; the flags below are Apple's.
    if (this.#platform !== "darwin") {
      return {
        available: false,
        reason: `${this.#binary} is macOS only, platform is ${this.#platform}`,
      };
    }
    if (!this.#runner.which(this.#binary)) {
      return { available: false, reason: `${this.#binary} is not on PATH` };
    }
    return { available: true, reason: `macOS ${this.#binary}` };
  }

  async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
    const probe = await this.probe();
    if (!probe.available) throw new TtsUnavailableError(probe.reason);

    for (const segment of segments) {
      const audio = await this.#render(segment);
      if (audio.pcm.length > 0) yield audio;
    }
  }

  async #render(text: string): Promise<PcmAudio> {
    return withScratchDir("ompd-say-", async (dir) => {
      const source = `${dir}/say.txt`;
      const out = `${dir}/say.wav`;
      await Bun.write(source, text);

      const args = ["-f", source, "-o", out, `--data-format=${SAY_DATA_FORMAT}`];
      if (this.#voice) args.push("-v", this.#voice);
      const result = await this.#runner.run(this.#binary, args, { timeoutMs: this.#timeoutMs });
      if (result.code !== 0) {
        throw new Error(
          `${this.#binary} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
        );
      }

      const wav = Bun.file(out);
      if (!(await wav.exists())) throw new Error(`${this.#binary} wrote no audio to ${out}`);
      return decodeWav(new Uint8Array(await wav.arrayBuffer()));
    });
  }
}

// ---------------------------------------------------------------------------
// null
// ---------------------------------------------------------------------------

/** Terminal engine. Speaking is optional, so failing here is loud but not fatal to a session. */
export class NullTtsEngine implements TtsEngine {
  readonly name = "null";

  #reasons: readonly string[];

  constructor(reasons: readonly string[] = []) {
    this.#reasons = reasons;
  }

  reasons(): readonly string[] {
    return this.#reasons;
  }

  async probe(): Promise<EngineAvailability> {
    return { available: false, reason: this.#describe() };
  }

  #describe(): string {
    if (this.#reasons.length === 0) return "no text-to-speech engine is configured";
    return `no text-to-speech engine is available: ${this.#reasons.join("; ")}`;
  }

  /** Fails on the first pull rather than yielding silence that looks like success. */
  async *stream(_segments: Iterable<string>): AsyncIterable<PcmAudio> {
    throw new TtsUnavailableError(this.#describe());
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export interface TtsSelectionOptions {
  runner?: CommandRunner;
  omp?: OmpTtsOptions;
  say?: SayTtsOptions;
  onLog?: (line: string) => void;
}

/** First engine whose probe passes, in `TTS_ENGINE_ORDER`. Never returns null. */
export async function selectTtsEngine(opts: TtsSelectionOptions = {}): Promise<TtsEngine> {
  const candidates: Array<OmpTtsEngine | SayTtsEngine> = [
    new OmpTtsEngine(opts.omp),
    new SayTtsEngine({ runner: opts.runner, ...opts.say }),
  ];

  const reasons: string[] = [];
  for (const engine of candidates) {
    const probe = await engine.probe();
    if (probe.available) {
      opts.onLog?.(`tts engine: ${engine.name} (${probe.reason})`);
      return engine;
    }
    reasons.push(`${engine.name}: ${probe.reason}`);
  }

  opts.onLog?.(`tts engine: null (${reasons.join("; ")})`);
  return new NullTtsEngine(reasons);
}
