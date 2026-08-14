/**
 * Playing the daemon's synthesized speech.
 *
 * The wire carries base64 16kHz mono PCM16, which is the one format both ends
 * already agree on for audio, so nothing here negotiates or converts beyond
 * what WebAudio requires: signed 16-bit integers become floats in [-1, 1].
 *
 * Two properties matter more than fidelity.
 *
 * Replies queue rather than overlap. Two answers arriving close together would
 * otherwise play on top of each other and neither would be understandable,
 * which is worse than waiting.
 *
 * Nothing here throws at the caller. This runs from a websocket frame handler,
 * and a browser that refused to start an AudioContext, or a frame that decoded
 * to nothing, must not take the connection down with it.
 */

/** The daemon's `speech` frames are always this. */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Full scale for signed 16-bit audio. Divides ints into [-1, 1). */
const INT16_SCALE = 32_768;

/**
 * The slice of `AudioContext` playback needs.
 *
 * Declared structurally so a test can drive the queue without a browser, and
 * so this file never has to care which of the two constructor names a given
 * engine ships.
 */
export interface AudioSink {
  readonly sampleRate: number;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike;
  readonly destination: AudioDestinationLike;
  close(): Promise<void>;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
  readonly duration: number;
}

export interface AudioDestinationLike {
  readonly maxChannelCount?: number;
}

export interface AudioSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: AudioDestinationLike): void;
  start(): void;
  stop(): void;
}

export interface SpeechPlayerOptions {
  /**
   * Built on first play, not at construction. A browser will not start an
   * AudioContext before a user gesture, and constructing one eagerly on page
   * load produces a permanently suspended context that never recovers.
   */
  createSink: () => AudioSink;
  onLog?: (line: string) => void;
}

/** base64 PCM16 to the floats WebAudio wants, or null if it decodes to nothing. */
export function decodePcm16(base64: string): Float32Array | null {
  if (base64.length === 0) return null;

  let binary = "";
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  // Odd length means a truncated final sample. Dropping the stray byte is
  // better than reading past it.
  const samples = Math.floor(binary.length / 2);
  if (samples === 0) return null;

  const floats = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    // Little-endian, matching `pcmToBase64` on the daemon side.
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    // Reinterpret the top bit as sign rather than magnitude.
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    floats[i] = signed / INT16_SCALE;
  }
  return floats;
}

export class SpeechPlayer {
  #createSink: () => AudioSink;
  #onLog: ((line: string) => void) | undefined;
  #sink: AudioSink | null = null;
  /** Resolves when the currently playing clip ends. */
  #tail: Promise<void> = Promise.resolve();
  #playing = 0;

  constructor(opts: SpeechPlayerOptions) {
    this.#createSink = opts.createSink;
    this.#onLog = opts.onLog;
  }

  /** How many clips are queued or sounding. Zero means silence. */
  get pending(): number {
    return this.#playing;
  }

  /**
   * Queue one speech frame.
   *
   * Resolves when that clip has finished, so a caller may await it, and false
   * means nothing was played: an undecodable frame, or a browser that would
   * not give us audio at all.
   */
  async play(base64Pcm: string): Promise<boolean> {
    const samples = decodePcm16(base64Pcm);
    if (samples === null) {
      this.#onLog?.("speech frame decoded to no samples");
      return false;
    }

    this.#playing += 1;
    const previous = this.#tail;
    const finished = Promise.withResolvers<void>();
    // Chained before awaiting anything, so two frames arriving in the same
    // tick queue in arrival order rather than racing to the sink.
    this.#tail = finished.promise;

    try {
      await previous;
      await this.#render(samples);
      return true;
    } catch (err) {
      this.#onLog?.(`speech playback failed: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      this.#playing -= 1;
      finished.resolve();
    }
  }

  async close(): Promise<void> {
    const sink = this.#sink;
    this.#sink = null;
    if (sink) await sink.close();
  }

  async #render(samples: Float32Array): Promise<void> {
    const sink = (this.#sink ??= this.#createSink());
    // A context created before a user gesture starts suspended, and a
    // suspended context plays nothing while reporting no error at all.
    if (sink.state === "suspended") await sink.resume();

    const buffer = sink.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);

    const source = sink.createBufferSource();
    source.buffer = buffer;
    source.connect(sink.destination);

    const ended = Promise.withResolvers<void>();
    source.onended = () => ended.resolve();
    source.start();
    await ended.promise;
  }
}

/**
 * The browser's `AudioContext`, adapted to `AudioSink`.
 *
 * Separate from the class above so every test drives the same queueing code a
 * browser does, with only this adapter unexercised.
 */
export function browserSink(): AudioSink {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) throw new Error("this browser has no AudioContext");
  // The daemon's rate, so the browser resamples once here rather than the
  // daemon guessing what the device wants.
  return new Ctor({ sampleRate: SPEECH_SAMPLE_RATE }) as unknown as AudioSink;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
