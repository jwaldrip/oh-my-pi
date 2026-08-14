/**
 * Speech to text.
 *
 * OMP already runs state of the art ASR on this machine, on device: Parakeet
 * TDT v3 through sherpa-onnx, warm across recordings. None of it is
 * reimplemented here. What was missing was a way to reach it from outside the
 * TUI, and now that the control plane lives inside the fork, the way to reach
 * it is to call `SttClient` directly rather than to hunt for a subcommand on a
 * binary.
 *
 * The engines are ordered omp, null. The last one is not a no-op: a voice
 * command that silently evaluates to the empty string is worse than one that
 * errors, because the operator has no way to tell "the daemon heard nothing"
 * from "the daemon has no ears". Every engine here either returns real text or
 * throws, and when it throws it names the engine and the reason.
 */

// Only the model registry is imported eagerly: it is plain data. Everything
// that reaches the native speech runtime goes through `loadSpeechRuntime`,
// which explains why.
import { DEFAULT_STT_MODEL_KEY, type SttModelKey } from "@oh-my-pi/pi-coding-agent/stt/models";
import { loadSpeechRuntime, type SttTranscriber } from "./speech-runtime.ts";
import type { EngineAvailability } from "./exec.ts";
import { pcmToFloat32, resampleFloat32 } from "./wav.ts";

export interface SttEngine {
  /** Selection slot, one of `STT_ENGINE_ORDER`. */
  readonly name: string;
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
}

export type { EngineAvailability };

/** The engine is not usable on this machine. Selection catches this; callers see it only from the null engine. */
export class SttUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttUnavailableError";
  }
}

/** The engine ran and produced nothing. Never collapsed into an empty transcript. */
export class EmptyTranscriptError extends Error {
  constructor(engine: string) {
    super(`${engine} returned no text for an utterance the endpointer accepted as speech`);
    this.name = "EmptyTranscriptError";
  }
}

/** The order `selectSttEngine` tries. */
export const STT_ENGINE_ORDER: readonly string[] = ["omp", "null"];

/**
 * The rate OMP's ASR worker is specified at. Not a tuning knob: the sherpa
 * frontend's window and hop are defined in samples against this rate, so audio
 * arriving at any other rate is transcribed as a pitch-shifted version of
 * itself.
 */
export const ASR_SAMPLE_RATE = 16_000;

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

/**
 * A structural type rather than OMP's class, so a test can substitute a fake
 * without spawning the worker subprocess. `SttClient` satisfies it as written.
 */
export type { SttTranscriber };

export interface OmpSttOptions {
  /** Defaults to OMP's process-wide warm client. */
  client?: SttTranscriber;
  /**
   * Model tier from OMP's registry. Defaults to `parakeet`. Typed against the
   * registry rather than `string`, so a stale key is a compile error here
   * instead of a silent downgrade to a different model at the first utterance.
   */
  modelKey?: SttModelKey;
  language?: string;
  /**
   * Whether the tier's weights are on disk. Defaults to OMP's own cache check;
   * injectable so a probe test does not depend on what this machine downloaded.
   */
  isModelCached?: (key: string) => Promise<boolean>;
}

/**
 * One-shot transcription on OMP's warm ASR worker.
 *
 * The worker keeps the model loaded across calls, so the cost of a second
 * utterance is inference alone. Nothing is written to disk and no subprocess is
 * spawned per utterance: the client owns a single worker for the daemon's life.
 */
export class OmpSttEngine implements SttEngine {
  readonly name = "omp";

  #client: SttTranscriber | undefined;
  #modelKey: SttModelKey;
  #language: string | undefined;
  #isModelCached: ((key: string) => Promise<boolean>) | undefined;
  #probed: EngineAvailability | null = null;

  constructor(opts: OmpSttOptions = {}) {
    this.#client = opts.client;
    this.#modelKey = opts.modelKey ?? DEFAULT_STT_MODEL_KEY;
    this.#language = opts.language;
    this.#isModelCached = opts.isModelCached;
  }

  /**
   * One question: are the weights on disk. Deliberately does not download
   * them. A daemon that pulled a multi-gigabyte model because a phone sent an
   * utterance would look like a hang, and the operator never asked for it.
   */
  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = await this.#runProbe();
    return this.#probed;
  }

  async #runProbe(): Promise<EngineAvailability> {
    let cached: boolean;
    try {
      const check = this.#isModelCached ?? (await loadSpeechRuntime()).isSttModelCached;
      cached = await check(this.#modelKey);
    } catch (err) {
      // Covers both a broken cache directory and a speech runtime that will not
      // load at all. Either way the operator needs the detail, not a bare
      // "unavailable".
      const detail = err instanceof Error ? err.message : String(err);
      return { available: false, reason: `omp could not reach its speech runtime: ${detail}` };
    }
    if (!cached) {
      return {
        available: false,
        reason: `omp speech-to-text model ${this.#modelKey} is not downloaded; run \`omp setup speech\``,
      };
    }
    return { available: true, reason: `omp ${this.#modelKey} on the local ASR worker` };
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const probe = await this.probe();
    if (!probe.available) throw new SttUnavailableError(probe.reason);

    const audio = resampleFloat32(pcmToFloat32(pcm), sampleRate, ASR_SAMPLE_RATE);
    let raw: string;
    try {
      this.#client ??= (await loadSpeechRuntime()).sttClient;
      raw = await this.#client.transcribe(this.#modelKey, audio, { language: this.#language });
    } catch (err) {
      // A worker that failed to spawn or load reports in its own vocabulary,
      // which reaches the operator as an error frame with no clue which half of
      // the voice stack broke. Named here so it does.
      const detail = err instanceof Error ? err.message : String(err);
      throw new SttUnavailableError(`omp ${this.#modelKey} could not transcribe: ${detail}`);
    }
    const text = raw.trim();
    if (!text) throw new EmptyTranscriptError(`omp ${this.#modelKey}`);
    return text;
  }
}

// ---------------------------------------------------------------------------
// null
// ---------------------------------------------------------------------------

/**
 * The terminal engine. It exists to make "this machine cannot hear you" a
 * first-class, reportable outcome instead of an empty string that looks like a
 * user who said nothing.
 */
export class NullSttEngine implements SttEngine {
  readonly name = "null";

  #reasons: readonly string[];

  constructor(reasons: readonly string[] = []) {
    this.#reasons = reasons;
  }

  /** Why each better engine was skipped. */
  reasons(): readonly string[] {
    return this.#reasons;
  }

  async probe(): Promise<EngineAvailability> {
    return { available: false, reason: this.#describe() };
  }

  #describe(): string {
    if (this.#reasons.length === 0) return "no speech-to-text engine is configured";
    return `no speech-to-text engine is available: ${this.#reasons.join("; ")}`;
  }

  async transcribe(_pcm: Int16Array, _sampleRate: number): Promise<string> {
    throw new SttUnavailableError(this.#describe());
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export interface SttSelectionOptions {
  omp?: OmpSttOptions;
  onLog?: (line: string) => void;
}

/**
 * First engine whose probe passes, in `STT_ENGINE_ORDER`. Never returns null:
 * the last slot is an engine that throws with the reasons the others declined.
 */
export async function selectSttEngine(opts: SttSelectionOptions = {}): Promise<SttEngine> {
  const candidates: OmpSttEngine[] = [new OmpSttEngine(opts.omp)];

  const reasons: string[] = [];
  for (const engine of candidates) {
    const probe = await engine.probe();
    if (probe.available) {
      opts.onLog?.(`stt engine: ${engine.name} (${probe.reason})`);
      return engine;
    }
    reasons.push(`${engine.name}: ${probe.reason}`);
  }

  opts.onLog?.(`stt engine: null (${reasons.join("; ")})`);
  return new NullSttEngine(reasons);
}
