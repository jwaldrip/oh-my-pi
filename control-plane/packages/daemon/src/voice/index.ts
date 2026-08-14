/**
 * Voice: carrying OMP's local speech stack over the network.
 *
 * Nothing here synthesises or recognises anything. OMP already runs Parakeet
 * TDT v3 and Kokoro-82M on device, and since the control plane lives inside the
 * fork it calls those libraries directly. The daemon's job is to make them
 * reachable from a phone, and to fail loudly when the machine has neither.
 */

export {
  VoiceBridge,
  VoiceBufferOverflowError,
  WIRE_SAMPLE_RATE,
  type VoiceBridgeOptions,
} from "./bridge.ts";
export {
  BunCommandRunner,
  CommandTimeoutError,
  withScratchDir,
  type CommandResult,
  type CommandRunner,
  type EngineAvailability,
} from "./exec.ts";
export {
  loadSpeechRuntime,
  resetSpeechRuntime,
  type SpeechRuntime,
  type TtsAudioChunk,
  type TtsStream,
} from "./speech-runtime.ts";
export {
  ASR_SAMPLE_RATE,
  EmptyTranscriptError,
  NullSttEngine,
  OmpSttEngine,
  selectSttEngine,
  STT_ENGINE_ORDER,
  SttUnavailableError,
  type OmpSttOptions,
  type SttEngine,
  type SttSelectionOptions,
  type SttTranscriber,
} from "./stt.ts";
export {
  NullTtsEngine,
  OmpTtsEngine,
  SayTtsEngine,
  selectTtsEngine,
  speakableSegments,
  TTS_ENGINE_ORDER,
  TtsUnavailableError,
  type OmpTtsOptions,
  type SayTtsOptions,
  type TtsEngine,
  type TtsSelectionOptions,
  type TtsSynthesizer,
} from "./tts.ts";
export {
  chunkFrames,
  detectUtteranceEnd,
  detectUtteranceEndFromEnergies,
  frameEnergy,
  resolveVadOptions,
  VAD_DEFAULTS,
  type ResolvedVadOptions,
  type VadOptions,
} from "./vad.ts";
export {
  base64ToPcm,
  decodeWav,
  encodeWav,
  float32ToPcm,
  pcmToBase64,
  pcmToFloat32,
  resampleFloat32,
  resamplePcm,
  WavFormatError,
  type PcmAudio,
} from "./wav.ts";
