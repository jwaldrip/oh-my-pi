/**
 * Speech playback, tested where it can actually be wrong.
 *
 * Decoding is the half that fails silently: PCM16 read as unsigned, or as
 * big-endian, still produces audio, just audio nobody can understand. So the
 * decode assertions are on exact sample values against bytes whose correct
 * interpretation is known, not on a length.
 *
 * Queueing is the half that fails audibly. Overlapped speech is unintelligible,
 * so the assertion is on the interleaving of starts and ends, not merely on the
 * order clips were handed over in.
 *
 * Nothing here sleeps or polls. The sink ends each clip as soon as it starts,
 * so the player's own promises are the only thing any test waits on.
 */

import { describe, expect, test } from "bun:test";
import {
  decodePcm16,
  SPEECH_SAMPLE_RATE,
  SpeechPlayer,
  type AudioBufferLike,
  type AudioSink,
  type AudioSourceLike,
} from "../src/voice/playback.ts";

/** base64 of little-endian PCM16 for the given samples. */
function encode(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [index, sample] of samples.entries()) view.setInt16(index * 2, sample, true);
  return btoa(String.fromCharCode(...bytes));
}

interface Recorded {
  sink: AudioSink;
  /** `start`/`end` in the order they happened, tagged with the first sample. */
  events: string[];
  /** Sample data handed to the sink, in the order playback started it. */
  started: Float32Array[];
  resumed: number;
  builds: number;
}

function recordingSink(opts: { state?: string } = {}): Recorded {
  const events: string[] = [];
  const started: Float32Array[] = [];
  let state = opts.state ?? "running";

  const recorded: Recorded = {
    events,
    started,
    resumed: 0,
    builds: 0,
    sink: {
      sampleRate: SPEECH_SAMPLE_RATE,
      get state() {
        return state;
      },
      resume: async () => {
        recorded.resumed += 1;
        state = "running";
      },
      createBuffer: (_channels, length): AudioBufferLike => {
        const data = new Float32Array(length);
        return { getChannelData: () => data, duration: length / SPEECH_SAMPLE_RATE };
      },
      createBufferSource: (): AudioSourceLike => {
        const source: AudioSourceLike = {
          buffer: null,
          onended: null,
          connect: () => {},
          start: () => {
            const data = source.buffer?.getChannelData(0) ?? new Float32Array(0);
            started.push(data);
            const tag = String(Math.round((data[0] ?? 0) * 32_768));
            events.push(`start ${tag}`);
            // Ends immediately. A clip whose end had to be triggered by the
            // test would need a signal, and a signal registered after the
            // event it waits for is a hang.
            events.push(`end ${tag}`);
            source.onended?.();
          },
          stop: () => {},
        };
        return source;
      },
      destination: {},
      close: async () => {},
    },
  };
  return recorded;
}

function playerFor(recorded: Recorded, onLog?: (line: string) => void): SpeechPlayer {
  return new SpeechPlayer({
    createSink: () => {
      recorded.builds += 1;
      return recorded.sink;
    },
    onLog,
  });
}

describe("decoding", () => {
  test("reads little-endian signed samples, not unsigned", () => {
    // -32768 and -1 are the two values an unsigned read gets spectacularly
    // wrong while still producing plausible-looking audio.
    const decoded = decodePcm16(encode([0, 32_767, -32_768, -1]));
    expect(Array.from(decoded ?? [])).toEqual([0, 32_767 / 32_768, -1, -1 / 32_768]);
  });

  test("nothing to play is null, not an empty buffer or a throw", () => {
    expect(decodePcm16("")).toBeNull();
    // One byte is half a sample; there is no first sample to play.
    expect(decodePcm16(btoa("\u0001"))).toBeNull();
    expect(decodePcm16("!!!not base64!!!")).toBeNull();
  });

  test("a trailing half sample is dropped rather than read past", () => {
    const truncated = btoa(atob(encode([1000, -1000])).slice(0, 3));
    expect(Array.from(decodePcm16(truncated) ?? [])).toEqual([1000 / 32_768]);
  });
});

describe("playback", () => {
  test("plays a frame through the sink", async () => {
    const recorded = recordingSink();
    const player = playerFor(recorded);

    expect(await player.play(encode([100, 200, 300]))).toBe(true);
    expect(Array.from(recorded.started[0] ?? [])).toEqual([
      100 / 32_768,
      200 / 32_768,
      300 / 32_768,
    ]);
    expect(player.pending).toBe(0);
  });

  test("two replies queue instead of overlapping", async () => {
    const recorded = recordingSink();
    const player = playerFor(recorded);

    // Started together, the way two frames arriving in one tick would be.
    const first = player.play(encode([1]));
    const second = player.play(encode([2]));
    expect(player.pending).toBe(2);

    expect(await Promise.all([first, second])).toEqual([true, true]);
    // The whole property in one assertion: the second clip does not start
    // until the first has ended. Overlapped speech is unintelligible, which is
    // worse than waiting a turn.
    expect(recorded.events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  test("a suspended context is resumed rather than silently playing nothing", async () => {
    const recorded = recordingSink({ state: "suspended" });
    const player = playerFor(recorded);

    expect(await player.play(encode([5]))).toBe(true);
    // A context built before a user gesture starts suspended and plays nothing
    // while reporting no error at all.
    expect(recorded.resumed).toBe(1);
  });

  test("the sink is built once, on first play rather than at construction", async () => {
    const recorded = recordingSink();
    const player = playerFor(recorded);
    // A browser refuses an AudioContext before a user gesture, and one built
    // at page load stays suspended forever.
    expect(recorded.builds).toBe(0);

    await player.play(encode([1]));
    expect(recorded.builds).toBe(1);

    await player.play(encode([2]));
    // Reused, not rebuilt. A context per reply exhausts the browser's limit.
    expect(recorded.builds).toBe(1);
  });

  test("an undecodable frame is reported, not thrown, and plays nothing", async () => {
    const recorded = recordingSink();
    const logs: string[] = [];
    const player = playerFor(recorded, (line) => logs.push(line));

    expect(await player.play("")).toBe(false);
    expect(recorded.started).toHaveLength(0);
    expect(logs.join("\n")).toContain("no samples");
  });

  test("a sink that throws does not take the caller down", async () => {
    const player = new SpeechPlayer({
      createSink: () => {
        throw new Error("no AudioContext in this browser");
      },
    });

    // This runs from a websocket frame handler. A browser without audio must
    // cost one log line, not the connection.
    expect(await player.play(encode([1]))).toBe(false);
    expect(player.pending).toBe(0);
  });
});
