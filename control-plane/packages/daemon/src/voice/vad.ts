/**
 * Energy-based voice activity detection.
 *
 * Deliberately not a model. The bridge only needs one decision -- "has the
 * speaker stopped?" -- and an RMS threshold with hysteresis answers it well
 * enough that adding a neural endpointer would buy latency and a download for
 * no behavioural gain. omp's own live STT reached the same conclusion: its
 * endpointer is energy based, no extra model.
 *
 * Two thresholds, not one. A single threshold chatters: any frame sitting near
 * it flips speech/silence on consecutive frames and shreds the trailing-silence
 * count that ends an utterance. So entering speech takes a crossing of the
 * high threshold and leaving it takes a fall below the low one, which is a
 * Schmitt trigger and is what "hysteresis" means here.
 *
 * Everything in this file is pure. The bridge holds the audio; this holds the
 * arithmetic, so the interesting behaviour is unit-testable against synthetic
 * PCM with no device and no I/O.
 */

export interface VadOptions {
  /** Frame width. 20ms is the usual VAD granularity and what the bridge chunks to. */
  frameMs?: number;
  /** RMS (0..1, full scale) a frame must exceed to *enter* speech. */
  speechThreshold?: number;
  /** RMS a frame must fall below to *leave* speech. Must not exceed `speechThreshold`. */
  silenceThreshold?: number;
  /** Speech frames required before an end of utterance can be declared at all. */
  minSpeechFrames?: number;
  /** Consecutive trailing silent frames that close the utterance. */
  hangoverFrames?: number;
}

export interface ResolvedVadOptions {
  frameMs: number;
  speechThreshold: number;
  silenceThreshold: number;
  minSpeechFrames: number;
  hangoverFrames: number;
}

/**
 * Defaults tuned for 16kHz phone-style speech.
 *
 * `hangoverFrames` is the one that shows up as feel: 35 frames is 700ms of
 * quiet, long enough to survive the pause before a subordinate clause and
 * short enough that a finished sentence does not sit there.
 */
export const VAD_DEFAULTS: ResolvedVadOptions = {
  frameMs: 20,
  speechThreshold: 0.02,
  silenceThreshold: 0.01,
  minSpeechFrames: 5,
  hangoverFrames: 35,
};

export function resolveVadOptions(opts: VadOptions = {}): ResolvedVadOptions {
  const resolved: ResolvedVadOptions = { ...VAD_DEFAULTS, ...opts };
  if (resolved.frameMs <= 0) throw new RangeError(`frameMs must be positive, got ${resolved.frameMs}`);
  if (resolved.silenceThreshold > resolved.speechThreshold) {
    throw new RangeError(
      `silenceThreshold ${resolved.silenceThreshold} exceeds speechThreshold ` +
        `${resolved.speechThreshold}; that inverts the hysteresis`,
    );
  }
  if (resolved.hangoverFrames < 1) {
    throw new RangeError(`hangoverFrames must be at least 1, got ${resolved.hangoverFrames}`);
  }
  return resolved;
}

/** Root mean square amplitude of a frame, normalised to 0..1 of full scale. */
export function frameEnergy(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = (frame[i] ?? 0) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Split PCM into whole frames of `frameMs`. A trailing partial frame is
 * dropped: the caller keeps it and prepends it to the next chunk, so no
 * samples are lost across a streamed boundary.
 */
export function chunkFrames(pcm: Int16Array, sampleRate: number, frameMs = VAD_DEFAULTS.frameMs): Int16Array[] {
  if (sampleRate <= 0) throw new RangeError(`sampleRate must be positive, got ${sampleRate}`);
  const width = Math.floor((sampleRate * frameMs) / 1000);
  if (width <= 0) throw new RangeError(`frame of ${frameMs}ms at ${sampleRate}Hz is empty`);
  const frames: Int16Array[] = [];
  for (let start = 0; start + width <= pcm.length; start += width) {
    frames.push(pcm.subarray(start, start + width));
  }
  return frames;
}

/**
 * The endpointer, over precomputed frame energies.
 *
 * A streaming caller computes each frame's energy exactly once as it arrives
 * and passes the accumulated array here, so a long utterance stays linear
 * rather than re-measuring the whole buffer on every 20ms packet.
 *
 * True only when speech was actually heard *and* the buffer ends in silence.
 * Both halves matter: without the first, a room tone recording ends an
 * utterance that never began; without the second, a pause mid-sentence cuts
 * the speaker off.
 */
export function detectUtteranceEndFromEnergies(
  energies: readonly number[],
  opts: VadOptions = {},
): boolean {
  const o = resolveVadOptions(opts);
  let inSpeech = false;
  let speechFrames = 0;
  let trailingSilence = 0;

  for (const energy of energies) {
    // The whole Schmitt trigger is this ternary, and it is easy to misread.
    // While OUT of speech the bar is the high threshold, so entering takes a
    // real onset. While IN speech the bar drops to the low one, so a frame
    // between the two thresholds still clears it and keeps the floor: the
    // `else` below is reached only by a frame at or under the LOW threshold.
    // Read it as one threshold and a quiet passage ends the utterance early.
    const threshold = inSpeech ? o.silenceThreshold : o.speechThreshold;
    if (energy > threshold) {
      inSpeech = true;
      speechFrames++;
      trailingSilence = 0;
    } else {
      inSpeech = false;
      // Silence before anyone has spoken is not trailing silence, it is a
      // caller who opened the mic early.
      if (speechFrames > 0) trailingSilence++;
    }
  }

  return speechFrames >= o.minSpeechFrames && trailingSilence >= o.hangoverFrames;
}

/**
 * The endpointer, over raw frames. Convenience form for callers holding audio
 * rather than energies, and the shape the bridge's behaviour is specified in.
 */
export function detectUtteranceEnd(frames: readonly Int16Array[], opts: VadOptions = {}): boolean {
  const energies: number[] = [];
  for (const frame of frames) energies.push(frameEnergy(frame));
  return detectUtteranceEndFromEnergies(energies, opts);
}
