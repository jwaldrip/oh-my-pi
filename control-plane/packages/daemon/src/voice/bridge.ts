/**
 * The voice bridge: audio in, transcript out, speech back.
 *
 * This is the whole point of the voice slice. OMP's speech stack is excellent
 * and entirely local, and entirely unreachable from anywhere but the terminal
 * it is running in. The bridge is what carries it over the socket, so a phone
 * can hold a conversation with an agent that lives in the daemon.
 *
 * Three properties it must hold, in order of how badly they hurt when wrong:
 *
 * 1. A command never vanishes. If transcription fails, the client is told. An
 *    empty transcript is treated as a failure, not as silence, because the
 *    operator cannot distinguish the two and will assume the agent heard them.
 * 2. Buffered audio is capped. A client that opens a microphone and walks away
 *    is the normal case, not the adversarial one, and an uncapped buffer turns
 *    it into daemon memory growth measured in megabytes a minute.
 * 3. Frame handling never throws. The gateway calls `handleFrame` straight
 *    from a socket message, so a malformed frame must produce an error frame,
 *    not an unhandled rejection.
 */

import { SCOPE_PROMPT, type Actor, type AgentId, type ClientFrame, type ServerFrame } from "@ompd/core";
import { UnauthorizedError } from "../supervisor.ts";
import { NullSttEngine, type SttEngine } from "./stt.ts";
import { NullTtsEngine, speakableSegments, type TtsEngine } from "./tts.ts";
import { detectUtteranceEndFromEnergies, frameEnergy, resolveVadOptions, type VadOptions } from "./vad.ts";
import { base64ToPcm, pcmToBase64, resamplePcm } from "./wav.ts";

/** Raised when an agent's buffered audio would exceed the cap. The buffer is dropped first. */
export class VoiceBufferOverflowError extends Error {
  readonly agentId: AgentId;
  readonly limitSeconds: number;

  constructor(agentId: AgentId, limitSeconds: number) {
    super(`buffered audio for ${agentId} exceeded ${limitSeconds}s; the utterance was dropped`);
    this.name = "VoiceBufferOverflowError";
    this.agentId = agentId;
    this.limitSeconds = limitSeconds;
  }
}

export interface VoiceBridgeOptions {
  /** Emit a frame to the client this bridge serves. */
  send: (frame: ServerFrame) => void;
  /** Defaults to a null engine, which errors explicitly rather than hearing nothing. */
  stt?: SttEngine;
  /** Defaults to a null engine. */
  tts?: TtsEngine;
  /**
   * Called with a finalised transcript, after the frame is emitted. This is
   * where the gateway turns speech into `Supervisor.prompt`; the bridge does
   * not call the supervisor itself, so authorization stays in one place.
   */
  onTranscript?: (agentId: AgentId, text: string, actor: Actor) => void | Promise<void>;
  /** Wire format is 16kHz mono PCM16. */
  sampleRate?: number;
  /** Hard ceiling on buffered audio per agent. */
  maxBufferedSeconds?: number;
  vad?: VadOptions;
  onLog?: (line: string) => void;
}

/** One in-flight utterance. Frames and their energies stay in lockstep. */
interface Utterance {
  frames: Int16Array[];
  /** Energy per frame, computed once on arrival so a long utterance stays linear. */
  energies: number[];
  /** Samples left over from the last chunk, shorter than one frame. */
  remainder: Int16Array;
  samples: number;
}

/**
 * The rate every `t: "audio"` and `t: "speech"` frame is in.
 *
 * Exported because it is a wire contract, not a tuning knob: a client encodes
 * to it and decodes from it, and a test that wants to know what the bridge
 * emits should read this rather than restate the number.
 */
export const WIRE_SAMPLE_RATE = 16_000;
const DEFAULT_MAX_BUFFERED_SECONDS = 60;

export class VoiceBridge {
  #send: (frame: ServerFrame) => void;
  #stt: SttEngine;
  #tts: TtsEngine;
  #onTranscript: VoiceBridgeOptions["onTranscript"];
  #sampleRate: number;
  #maxBufferedSeconds: number;
  #frameWidth: number;
  #vad: VadOptions;
  #onLog: ((line: string) => void) | undefined;

  #utterances = new Map<AgentId, Utterance>();
  /** Agents with a transcription in flight, so a late chunk cannot double-flush. */
  #flushing = new Set<AgentId>();
  #closed = false;

  constructor(opts: VoiceBridgeOptions) {
    this.#send = opts.send;
    this.#stt = opts.stt ?? new NullSttEngine();
    this.#tts = opts.tts ?? new NullTtsEngine();
    this.#onTranscript = opts.onTranscript;
    this.#sampleRate = opts.sampleRate ?? WIRE_SAMPLE_RATE;
    this.#maxBufferedSeconds = opts.maxBufferedSeconds ?? DEFAULT_MAX_BUFFERED_SECONDS;
    this.#vad = opts.vad ?? {};
    this.#onLog = opts.onLog;

    const vad = resolveVadOptions(this.#vad);
    this.#frameWidth = Math.floor((this.#sampleRate * vad.frameMs) / 1000);
    if (this.#frameWidth <= 0) {
      throw new RangeError(`a ${vad.frameMs}ms frame at ${this.#sampleRate}Hz holds no samples`);
    }
  }

  /** Names of the engines actually in use, for startup logs and diagnostics. */
  engines(): { stt: string; tts: string } {
    return { stt: this.#stt.name, tts: this.#tts.name };
  }

  /** Seconds of audio currently buffered for an agent. */
  bufferedSeconds(agentId: AgentId): number {
    const state = this.#utterances.get(agentId);
    if (!state) return 0;
    return state.samples / this.#sampleRate;
  }

  /**
   * Dispatch a client frame. Only `audio` and `audio_end` are ours; anything
   * else is someone else's business and is ignored.
   *
   * Never throws. The gateway calls this from a socket message handler, so a
   * failure has to travel back as a frame or it takes the connection with it.
   */
  async handleFrame(frame: ClientFrame, actor: Actor): Promise<void> {
    try {
      if (frame.t === "audio") {
        await this.pushAudio(frame.agentId, frame.pcm, actor);
      } else if (frame.t === "audio_end") {
        await this.endAudio(frame.agentId, actor);
      }
    } catch (err) {
      const agentId = "agentId" in frame ? frame.agentId : undefined;
      const code = err instanceof VoiceBufferOverflowError ? "voice_buffer_overflow" : "voice_error";
      this.#fail(agentId, err, code);
    }
  }

  /**
   * Buffer a chunk of base64 PCM16 and end the utterance if the speaker has
   * stopped.
   *
   * Throws for a caller-side fault: no prompt scope, malformed audio, or a
   * buffer over the cap. A transcription failure is not one of those, so it
   * arrives as an error frame instead.
   */
  async pushAudio(agentId: AgentId, base64Pcm: string, actor: Actor): Promise<void> {
    this.#authorize(actor);
    if (this.#closed) throw new Error("voice bridge is closed");

    const chunk = base64ToPcm(base64Pcm);
    if (chunk.length === 0) return;

    const state = this.#stateFor(agentId);
    const limit = this.#maxBufferedSeconds * this.#sampleRate;
    if (state.samples + chunk.length > limit) {
      // Drop first, then report. Holding the buffer while raising would leave
      // the very growth the cap exists to prevent.
      this.#utterances.delete(agentId);
      const err = new VoiceBufferOverflowError(agentId, this.#maxBufferedSeconds);
      this.#send({ t: "error", agentId, message: err.message, code: "voice_buffer_overflow" });
      throw err;
    }

    const combined = new Int16Array(state.remainder.length + chunk.length);
    combined.set(state.remainder, 0);
    combined.set(chunk, state.remainder.length);

    let offset = 0;
    while (offset + this.#frameWidth <= combined.length) {
      const frame = combined.subarray(offset, offset + this.#frameWidth);
      state.frames.push(frame);
      state.energies.push(frameEnergy(frame));
      offset += this.#frameWidth;
    }
    state.remainder = combined.subarray(offset);
    state.samples += chunk.length;

    if (detectUtteranceEndFromEnergies(state.energies, this.#vad)) {
      await this.#flush(agentId, actor, "endpointer");
    }
  }

  /** Explicit end of stream. Transcribes whatever is buffered. */
  async endAudio(agentId: AgentId, actor: Actor): Promise<void> {
    this.#authorize(actor);
    await this.#flush(agentId, actor, "audio_end");
  }

  /**
   * Speak text back to the client.
   *
   * Segmented first, then synthesised segment by segment, and each segment's
   * audio goes out as its own `speech` frame the moment it is rendered. That is
   * the difference between a phone that starts talking on the first clause and
   * one that waits for the whole paragraph to come out of the vocoder.
   *
   * Returns false when there was nothing worth saying: a turn that was only a
   * code fence has no speakable segments, and silence is the right answer there.
   */
  async speak(agentId: AgentId, text: string): Promise<boolean> {
    if (this.#closed) return false;
    const segments = speakableSegments(text);
    if (segments.length === 0) return false;

    let sent = 0;
    try {
      for await (const audio of this.#tts.stream(segments)) {
        // The wire says 16kHz and the engines disagree: Kokoro renders at 24k
        // and `say` at 22.05k. Sending those samples unchanged does not fail,
        // it just plays slowly and an octave down, which sounds like a bad
        // model rather than a bad conversion.
        const wire = resamplePcm(audio, this.#sampleRate);
        if (wire.pcm.length === 0) continue;
        this.#send({ t: "speech", agentId, pcm: pcmToBase64(wire.pcm) });
        sent++;
        // A client that disconnects mid-utterance closes the bridge; stop
        // pulling from the engine rather than rendering audio for nobody.
        if (this.#closed) break;
      }
    } catch (err) {
      this.#fail(agentId, err, "tts_failed");
      return false;
    }
    return sent > 0;
  }

  /** Discard an agent's buffered audio without transcribing it. */
  reset(agentId: AgentId): void {
    this.#utterances.delete(agentId);
  }

  /** Drop every buffer. In-flight transcriptions are allowed to finish. */
  close(): void {
    this.#closed = true;
    this.#utterances.clear();
  }

  // -- internals -----------------------------------------------------------

  /**
   * Defence in depth. The supervisor authorizes the prompt this transcript
   * becomes, but audio should not be buffered at all for a device that could
   * never send a prompt.
   */
  #authorize(actor: Actor): void {
    if (!actor.scopes.includes(SCOPE_PROMPT)) {
      throw new UnauthorizedError(`voice.audio: missing ${SCOPE_PROMPT} scope`);
    }
  }

  #stateFor(agentId: AgentId): Utterance {
    const existing = this.#utterances.get(agentId);
    if (existing) return existing;
    const fresh: Utterance = {
      frames: [],
      energies: [],
      remainder: new Int16Array(0),
      samples: 0,
    };
    this.#utterances.set(agentId, fresh);
    return fresh;
  }

  async #flush(agentId: AgentId, actor: Actor, cause: string): Promise<void> {
    const state = this.#utterances.get(agentId);
    if (!state || state.samples === 0) return;
    if (this.#flushing.has(agentId)) return;

    // Clear before transcribing: audio that arrives during the await belongs
    // to the next utterance, not this one.
    this.#utterances.delete(agentId);
    this.#flushing.add(agentId);

    const pcm = new Int16Array(state.samples);
    let offset = 0;
    for (const frame of state.frames) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    pcm.set(state.remainder, offset);

    // One try/finally around everything after the guard is taken. The two
    // failures below are reported with different codes because they mean
    // different things to the operator, but neither may leave the guard set:
    // a stuck guard makes every later utterance for this agent hit the
    // re-entrancy check and vanish, which is silent permanent loss. `#send`
    // is inside deliberately, since a socket that fails mid-transcript is the
    // most likely thing here to throw.
    try {
      let text: string;
      try {
        text = await this.#stt.transcribe(pcm, this.#sampleRate);
      } catch (err) {
        // The operator spoke and nothing happened. That must be visible.
        this.#fail(agentId, err, "stt_failed");
        return;
      }

      this.#onLog?.(`voice: ${cause} transcript for ${agentId} (${text.length} chars)`);
      this.#send({ t: "transcript", agentId, text, final: true });

      try {
        // Reported separately from transcription. Collapsing the two into one
        // code told the operator their speech was not understood when it was
        // understood perfectly and the prompt it became was refused, which
        // sends them to the microphone to fix a problem that is not there.
        await this.#onTranscript?.(agentId, text, actor);
      } catch (err) {
        this.#fail(agentId, err, "voice_prompt_failed");
      }
    } finally {
      this.#flushing.delete(agentId);
    }
  }

  #fail(agentId: AgentId | undefined, err: unknown, code: string): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#onLog?.(`voice error (${code}) for ${agentId ?? "no agent"}: ${message}`);
    try {
      this.#send({ t: "error", agentId, message, code });
    } catch (sendErr) {
      // Already on the failure path, and the channel we would report on is the
      // thing that just broke. Log and swallow: `handleFrame` promises the
      // gateway it never throws, and a dead socket must not become an
      // unhandled rejection in the socket handler that owns it.
      const detail = sendErr instanceof Error ? sendErr.message : String(sendErr);
      this.#onLog?.(`voice: could not deliver ${code} to ${agentId ?? "no agent"}: ${detail}`);
    }
  }
}
