/**
 * The one door into OMP's speech stack.
 *
 * Two things force this module to exist.
 *
 * The first is that OMP's speech clients reach a platform-specific native
 * addon. Importing them at module load would make merely importing the voice
 * barrel depend on a compiled binary, so a daemon on a machine without the
 * speech runtime built would fail to start instead of reporting that it cannot
 * hear. They are therefore loaded on first use.
 *
 * The second is subtler and was found by running the two probes in both
 * orders. When that graph fails to initialise, the half-evaluated modules stay
 * in the loader's cache, and the *next* import of an overlapping specifier
 * surfaces a temporal-dead-zone artifact from inside upstream rather than the
 * real cause. The observable effect was that whichever engine probed second
 * reported "Cannot access 'compiledTemplateCache' before initialization" while
 * the one that probed first reported the truth, "Failed to load pi_natives
 * native addon". An operator told the second thing has no way to reach the
 * first, so both engines load through here instead, once, and share the answer.
 *
 * The outcome is memoised in both directions. A rejection is cached
 * deliberately: the reason a speech runtime will not load is that a binary is
 * absent, which cannot change while this process is alive, and retrying only
 * produces the misleading second error described above.
 */

/** The slice of OMP's `SttClient` the voice engines use. */
export interface SttTranscriber {
  transcribe(
    modelKey: string,
    audio: Float32Array,
    options?: { language?: string; signal?: AbortSignal },
  ): Promise<string>;
}

/** One synthesized segment, as OMP's streaming client emits it. */
export interface TtsAudioChunk {
  index: number;
  text: string;
  pcm: Float32Array;
  sampleRate: number;
}

/** The slice of OMP's `TtsStreamHandle` the voice engines use. */
export interface TtsStream {
  push(text: string): void;
  end(): void;
  chunks: AsyncIterableIterator<TtsAudioChunk>;
}

/** The slice of OMP's `TtsClient` the voice engines use. */
export interface TtsSynthesizer {
  synthesizeStream(modelKey: string, options?: { voice?: string; signal?: AbortSignal }): TtsStream;
}

/** Everything the engines need from upstream, resolved together. */
export interface SpeechRuntime {
  sttClient: SttTranscriber;
  isSttModelCached: (key: string) => Promise<boolean>;
  ttsClient: TtsSynthesizer;
  isTtsModelCached: (key: string) => Promise<boolean>;
  isTtsRuntimeCached: () => Promise<boolean>;
}

let pending: Promise<SpeechRuntime> | null = null;

/**
 * Load OMP's speech stack, once per process.
 *
 * Every specifier is imported in one place and in one pass, so a failure is
 * reported with the cause that actually occurred rather than with whatever the
 * loader cache makes of a retry.
 */
export function loadSpeechRuntime(): Promise<SpeechRuntime> {
  // Dynamic imports: these modules reach a platform-specific native addon that
  // is absent wherever the speech runtime has not been built. Static imports
  // would move that failure to module-load time, which is the whole thing this
  // module exists to avoid.
  pending ??= (async (): Promise<SpeechRuntime> => {
    const [asr, sttDownloader, tts, ttsDownloader, ttsRuntime] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/stt/asr-client"),
      import("@oh-my-pi/pi-coding-agent/stt/downloader"),
      import("@oh-my-pi/pi-coding-agent/tts/tts-client"),
      import("@oh-my-pi/pi-coding-agent/tts/downloader"),
      import("@oh-my-pi/pi-coding-agent/tts/runtime"),
    ]);
    return {
      sttClient: asr.sttClient,
      isSttModelCached: sttDownloader.isSttModelCached,
      ttsClient: tts.ttsClient,
      isTtsModelCached: ttsDownloader.isTtsModelCached,
      isTtsRuntimeCached: ttsRuntime.isTtsRuntimeCached,
    };
  })();
  return pending;
}

/**
 * Drop the memoised runtime. Tests only: a process that has loaded the speech
 * stack has no reason to unload it.
 */
export function resetSpeechRuntime(): void {
  pending = null;
}
