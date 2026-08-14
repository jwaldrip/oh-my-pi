#!/usr/bin/env bun
/**
 * Prove the voice loop on this machine, end to end, with real audio.
 *
 * Every other check in this repo runs the bridge against a scripted engine
 * that returns whatever the test wanted to hear. This one does not fake
 * anything: it synthesises a known sentence with the speech engine the daemon
 * actually selected, feeds those samples back in as base64 PCM16 the way a
 * browser recorder would, lets the real endpointer decide the speaker stopped,
 * and reads the transcript out of a real socket frame from a real daemon.
 *
 * Six stages, each one a thing that can independently be false:
 *
 *   1. machine    what the host actually provides, measured not assumed
 *   2. selection  which engines `selectSttEngine`/`selectTtsEngine` resolve to
 *   3. synthesis  a wav of a known sentence, from the real TTS engine
 *   4. bridge     VAD ends the utterance and STT returns matching text
 *   5. socket     the same audio over `audio`/`audio_end` against a live daemon
 *   6. cleanup    every byte and port this script created is gone
 *
 * A stage that fails prints why and the script exits non-zero. Failure here is
 * a legitimate result: "this machine cannot hear" is worth knowing precisely,
 * and is much more useful than a green run that proved nothing.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STT_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/stt/models";
import { DEFAULT_TTS_LOCAL_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/tts/models";
import { Ompd } from "../packages/daemon/src/daemon.ts";
import {
  BunCommandRunner,
  encodeWav,
  OmpSttEngine,
  OmpTtsEngine,
  pcmToBase64,
  selectSttEngine,
  selectTtsEngine,
  speakableSegments,
  VoiceBridge,
  type EngineAvailability,
  type PcmAudio,
  type SttEngine,
  type TtsEngine,
} from "../packages/daemon/src/voice/index.ts";
import type { Actor, ServerFrame } from "@ompd/core";

/**
 * Distinctive enough that a hallucinated transcript cannot accidentally match,
 * and long enough to clear the endpointer's five-frame speech minimum.
 */
const DEFAULT_SENTENCE = "The quick brown fox jumps over the lazy dog.";

/** The wire format the bridge and OMP's ASR worker both expect. */
const WIRE_RATE = 16_000;

/**
 * Trailing quiet appended to the utterance.
 *
 * The endpointer needs `hangoverFrames` (35) consecutive 20ms frames below the
 * silence threshold, which is 700ms. 1200ms leaves margin for the tail of the
 * synthesised word decaying through the threshold without making the run slow.
 */
const TRAILING_SILENCE_MS = 1_200;

/** 100ms packets, which is what a MediaRecorder timeslice looks like. */
const PACKET_MS = 100;

/**
 * Word error rate ceiling for "reasonably matching".
 *
 * Not zero: this is real ASR over synthetic speech, and demanding an exact
 * string would make the check fail for the wrong reason the first time a model
 * writes "dog" without the period. 0.34 accepts a third of the words being
 * wrong, which no hallucination or wrong-utterance result survives.
 */
const MAX_WORD_ERROR_RATE = 0.34;

const SPEAKER: Actor = { deviceId: "dev_check_voice_loop", scopes: ["read", "prompt"] };

/** Never a real agent: the socket leg proves frame routing, not a model turn. */
const AGENT_ID = "agt_check_voice_loop";

/**
 * A prerequisite this machine does not have. Distinguished from a real crash
 * so the summary can report "not configured" without a stack trace that makes
 * a known, expected answer look like the diagnostic fell over.
 */
class PrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrerequisiteError";
  }
}

/**
 * `UNPROVEN` is not a soft failure. It marks a leg this script deliberately
 * does not exercise, so the summary can never be read as covering it. A run
 * with unproven legs still exits zero, because they are out of scope by
 * design rather than broken, but they are printed every time so the scope is
 * impossible to forget.
 */
type Status = "PASS" | "FAIL" | "UNPROVEN";

interface StageResult {
  name: string;
  status: Status;
  detail: string;
}

const results: StageResult[] = [];
let failed = false;

function heading(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function record(name: string, ok: boolean, detail: string): void {
  const status: Status = ok ? "PASS" : "FAIL";
  results.push({ name, status, detail });
  if (!ok) failed = true;
  console.log(`\n[${status}] ${name}: ${detail}`);
}

function unproven(name: string, detail: string): void {
  results.push({ name, status: "UNPROVEN", detail });
  console.log(`\n[UNPROVEN] ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------

/**
 * Linear resampling to the wire rate.
 *
 * Kokoro synthesises at 24kHz and both the bridge's endpointer thresholds and
 * the ASR frontend are specified at 16kHz, so the rate has to be converted
 * somewhere. Linear interpolation is enough: the signal is speech that has
 * already been through a vocoder, and the alternative is a windowed-sinc
 * kernel whose only observable effect here would be a slightly different WER.
 */
function resamplePcm16(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const ratio = from / to;
  const length = Math.floor(pcm.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, pcm.length - 1);
    const frac = source - left;
    out[i] = Math.round((pcm[left] ?? 0) * (1 - frac) + (pcm[right] ?? 0) * frac);
  }
  return out;
}

function withTrailingSilence(pcm: Int16Array, rate: number, ms: number): Int16Array {
  const out = new Int16Array(pcm.length + Math.floor((rate * ms) / 1000));
  out.set(pcm, 0);
  return out;
}

/**
 * Drain a streaming engine into one utterance.
 *
 * The engine emits a chunk per speakable segment. This script needs a single
 * waveform to write as a wav and to feed back in as one utterance, so the
 * chunks are concatenated here rather than the engine being asked for a shape
 * it deliberately no longer has. Segment count is returned so stage 3 can
 * report that streaming actually happened.
 */
async function renderUtterance(
  engine: TtsEngine,
  text: string,
): Promise<PcmAudio & { segments: number }> {
  const chunks: PcmAudio[] = [];
  for await (const chunk of engine.stream(speakableSegments(text))) chunks.push(chunk);
  if (chunks.length === 0) throw new Error(`${engine.name} produced no audio for ${text}`);

  // Every chunk comes from one engine in one session, so the rate is constant.
  const sampleRate = chunks[0]?.sampleRate ?? WIRE_RATE;
  let total = 0;
  for (const chunk of chunks) total += chunk.pcm.length;
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk.pcm, offset);
    offset += chunk.pcm.length;
  }
  return { pcm, sampleRate, segments: chunks.length };
}

/**
 * Levenshtein distance over words, normalised by reference length.
 *
 * Word level rather than character level because a transcript that says
 * "fox jumped" instead of "fox jumps" is a correct hearing of one word, and
 * character distance would score it as most of a word plus punctuation noise.
 */
function wordErrorRate(reference: string, hypothesis: string): number {
  const normalise = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0);

  const ref = normalise(reference);
  const hyp = normalise(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i, ...Array.from({ length: hyp.length }, () => 0)];
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return (previous[hyp.length] ?? 0) / ref.length;
}

// ---------------------------------------------------------------------------
// stage 1: machine
// ---------------------------------------------------------------------------

interface MachineFacts {
  ompPresent: boolean;
  sttModel: string;
  stt: EngineAvailability;
  ttsModel: string;
  tts: EngineAvailability;
}

/**
 * What the host actually provides, measured rather than assumed.
 *
 * Asked through the engines' own probes rather than of the model cache
 * directly. A script that answered the question a different way could pass on
 * a machine whose daemon comes up deaf, which is the rigged green this check
 * exists to refuse. It also means a speech runtime that will not load at all
 * is reported here as the reason, rather than crashing the diagnostic.
 */
async function describeMachine(): Promise<MachineFacts> {
  const [stt, tts] = await Promise.all([
    new OmpSttEngine().probe(),
    new OmpTtsEngine().probe(),
  ]);

  return {
    ompPresent: new BunCommandRunner().which("omp") !== null,
    sttModel: DEFAULT_STT_MODEL_KEY,
    stt,
    ttsModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
    tts,
  };
}

// ---------------------------------------------------------------------------
// stage 4: the bridge, in process
// ---------------------------------------------------------------------------

interface Handoff {
  agentId: string;
  text: string;
  deviceId: string;
}

interface BridgeOutcome {
  frames: ServerFrame[];
  logs: string[];
  transcript: string | null;
  endedByVad: boolean;
  /**
   * What the bridge handed to `onTranscript`, which is the exact seam the
   * daemon plugs `Supervisor.prompt` into. Captured rather than left to the
   * socket stage because satisfying it for real means spawning an agent and
   * billing a model turn, and the contract worth checking is that the right
   * text arrives under the right actor.
   */
  handoff: Handoff | null;
}

async function driveBridge(stt: SttEngine, tts: TtsEngine, pcm: Int16Array): Promise<BridgeOutcome> {
  const frames: ServerFrame[] = [];
  const logs: string[] = [];
  let handoff: Handoff | null = null;
  const bridge = new VoiceBridge({
    send: (frame) => frames.push(frame),
    stt,
    tts,
    sampleRate: WIRE_RATE,
    onTranscript: (agentId, text, actor) => {
      handoff = { agentId, text, deviceId: actor.deviceId };
    },
    onLog: (line) => logs.push(line),
  });

  const packet = (WIRE_RATE * PACKET_MS) / 1000;
  for (let offset = 0; offset < pcm.length; offset += packet) {
    await bridge.pushAudio(AGENT_ID, pcmToBase64(pcm.subarray(offset, offset + packet)), SPEAKER);
  }

  // Only if the endpointer did not already fire. Reaching this means the VAD
  // failed to notice 1200ms of silence, which the stage reports as such.
  const endedByVad = logs.some((line) => line.includes("endpointer"));
  if (!endedByVad) await bridge.endAudio(AGENT_ID, SPEAKER);

  const transcript = frames.find((frame) => frame.t === "transcript");
  bridge.close();

  return {
    frames,
    logs,
    endedByVad,
    handoff,
    transcript: transcript !== undefined && "text" in transcript ? transcript.text : null,
  };
}

// ---------------------------------------------------------------------------
// stage 5: the socket, against a live daemon
// ---------------------------------------------------------------------------

interface SocketOutcome {
  port: number;
  home: string;
  transcript: string | null;
  errors: string[];
  logs: string[];
}

/**
 * Start a throwaway daemon on an ephemeral port and speak to it over a real
 * websocket.
 *
 * Port 0 and a temp home, so this can never collide with a daemon the operator
 * is already running. The daemon is stopped and the home removed by the
 * caller's finally block, including when a stage throws.
 *
 * The agent id is deliberately not a real agent. Everything this stage exists
 * to prove -- token auth on the upgrade, the prompt-scope check, the per-socket
 * VoiceBridge the gateway builds in `#open`, frame routing, the endpointer and
 * the transcription -- happens before the transcript frame is sent, and the
 * `onTranscript` callback that follows it hands the text to `Supervisor.prompt`,
 * which spawns `omp acp` and bills a model turn. Creating a real agent to
 * satisfy that callback would put an unsupervised agent turn inside a
 * diagnostic script. The failure it logs instead is printed below, so the
 * boundary is visible rather than hidden.
 */
async function driveSocket(home: string, spoken: string): Promise<SocketOutcome> {
  const logs: string[] = [];
  const daemon = new Ompd({
    home,
    overrides: { port: 0 },
    voice: true,
    onLog: (line) => logs.push(line),
  });

  try {
    const info = await daemon.start();
    const token = (await Bun.file(daemon.tokenPath).text()).trim();

    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/v1/socket?token=${token}`);
    const open = Promise.withResolvers<void>();
    const done = Promise.withResolvers<string>();
    const errors: string[] = [];

    socket.addEventListener("open", () => open.resolve());
    socket.addEventListener("error", () => open.reject(new Error("socket failed to open")));
    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      if (frame.t === "transcript" && "text" in frame) done.resolve(frame.text);
      if (frame.t === "error" && "message" in frame) errors.push(`${frame.code}: ${frame.message}`);
    });
    await open.promise;

    // Synthesised fresh through the daemon's own engines rather than reusing
    // stage 3's samples, so this leg stands on its own.
    const tts = await selectTtsEngine();
    const audio = await renderUtterance(tts, spoken);
    const pcm = withTrailingSilence(
      resamplePcm16(audio.pcm, audio.sampleRate, WIRE_RATE),
      WIRE_RATE,
      TRAILING_SILENCE_MS,
    );

    const packet = (WIRE_RATE * PACKET_MS) / 1000;
    for (let offset = 0; offset < pcm.length; offset += packet) {
      socket.send(
        JSON.stringify({
          t: "audio",
          agentId: AGENT_ID,
          pcm: pcmToBase64(pcm.subarray(offset, offset + packet)),
        }),
      );
    }
    socket.send(JSON.stringify({ t: "audio_end", agentId: AGENT_ID }));

    const timeout = setTimeout(() => done.reject(new Error("no transcript frame in 180s")), 180_000);
    let transcript: string | null = null;
    try {
      transcript = await done.promise;
    } finally {
      clearTimeout(timeout);
      socket.close();
    }

    return { port: info.port, home, transcript, errors, logs };
  } finally {
    await daemon.stop();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const sentence = flag("sentence") ?? DEFAULT_SENTENCE;

console.log(`ompd voice loop check
sentence: ${JSON.stringify(sentence)}`);

let scratch: string | null = null;

try {
  // -- stage 1 --------------------------------------------------------------
  heading("stage 1: machine");
  const facts = await describeMachine();
  console.log(`omp on PATH:            ${facts.ompPresent}`);
  console.log(`stt (${facts.sttModel}):${" ".repeat(Math.max(1, 16 - facts.sttModel.length))}${facts.stt.reason}`);
  console.log(`tts (${facts.ttsModel}):${" ".repeat(Math.max(1, 18 - facts.ttsModel.length))}${facts.tts.reason}`);
  record("machine has a usable ASR path", facts.stt.available, facts.stt.reason);

  // -- stage 2 --------------------------------------------------------------
  heading("stage 2: engine selection");
  const selectionLog: string[] = [];
  const stt = await selectSttEngine({ onLog: (line) => selectionLog.push(line) });
  const tts = await selectTtsEngine({ onLog: (line) => selectionLog.push(line) });
  for (const line of selectionLog) console.log(line);
  record(
    "an stt engine other than null resolves",
    stt.name !== "null",
    `stt=${stt.name} tts=${tts.name}`,
  );
  if (stt.name === "null") {
    // Not a crash. A machine with nothing configured is a legitimate answer
    // this script is here to report, and a stack trace would make a known
    // outcome look like the diagnostic itself broke.
    throw new PrerequisiteError("no speech-to-text engine, so stages 3 to 5 cannot run");
  }

  // -- stage 3 --------------------------------------------------------------
  heading("stage 3: synthesis");
  scratch = mkdtempSync(join(tmpdir(), "ompd-voice-check-"));
  const spoken = await renderUtterance(tts, sentence);
  const wire = resamplePcm16(spoken.pcm, spoken.sampleRate, WIRE_RATE);
  const utterance = withTrailingSilence(wire, WIRE_RATE, TRAILING_SILENCE_MS);
  const wavPath = join(scratch, "utterance.wav");
  await Bun.write(wavPath, encodeWav({ pcm: utterance, sampleRate: WIRE_RATE }));
  console.log(`engine:      ${tts.name}`);
  console.log(`segments:    ${spoken.segments}`);
  console.log(`native rate: ${spoken.sampleRate}Hz, ${spoken.pcm.length} samples`);
  console.log(`wire rate:   ${WIRE_RATE}Hz, ${wire.length} samples`);
  console.log(`utterance:   ${(utterance.length / WIRE_RATE).toFixed(2)}s including ${TRAILING_SILENCE_MS}ms of trailing silence`);
  console.log(`wav:         ${wavPath}`);
  record(
    "tts produced real audio",
    spoken.pcm.length > WIRE_RATE / 4,
    `${(spoken.pcm.length / spoken.sampleRate).toFixed(2)}s from ${tts.name} in ${spoken.segments} segment(s)`,
  );

  // -- stage 4 --------------------------------------------------------------
  heading("stage 4: bridge, in process");
  const bridge = await driveBridge(stt, tts, utterance);
  for (const line of bridge.logs) console.log(`log: ${line}`);
  for (const frame of bridge.frames) console.log(`frame: ${JSON.stringify(frame).slice(0, 300)}`);
  record("vad ended the utterance", bridge.endedByVad, bridge.endedByVad
    ? "the endpointer fired before audio_end was needed"
    : "the endpointer never fired; audio_end had to force the flush");

  const bridgeWer = bridge.transcript === null ? 1 : wordErrorRate(sentence, bridge.transcript);
  console.log(`\nspoken:     ${JSON.stringify(sentence)}`);
  console.log(`transcript: ${JSON.stringify(bridge.transcript)}`);
  console.log(`engine:     ${stt.name}`);
  console.log(`word error rate: ${bridgeWer.toFixed(3)} (ceiling ${MAX_WORD_ERROR_RATE})`);
  record(
    "transcript matches the spoken sentence",
    bridgeWer <= MAX_WORD_ERROR_RATE,
    `wer ${bridgeWer.toFixed(3)} via ${stt.name}`,
  );

  const handoff = bridge.handoff;
  console.log(`handoff:    ${JSON.stringify(handoff)}`);
  record(
    "the transcript reached the onTranscript seam",
    handoff !== null && handoff.text === bridge.transcript && handoff.deviceId === SPEAKER.deviceId,
    handoff === null
      ? "onTranscript never fired, so nothing would ever become a prompt"
      : `${handoff.agentId} under ${handoff.deviceId}`,
  );

  // -- stage 5 --------------------------------------------------------------
  heading("stage 5: socket, against a live daemon");
  const home = mkdtempSync(join(tmpdir(), "ompd-voice-home-"));
  try {
    const socket = await driveSocket(home, sentence);
    for (const line of socket.logs) console.log(`daemon: ${line}`);
    console.log(`\nport:       ${socket.port} (ephemeral)`);
    console.log(`home:       ${socket.home}`);
    console.log(`transcript: ${JSON.stringify(socket.transcript)}`);
    for (const err of socket.errors) console.log(`error frame: ${err}`);

    const socketWer = socket.transcript === null ? 1 : wordErrorRate(sentence, socket.transcript);
    console.log(`word error rate: ${socketWer.toFixed(3)}`);
    record(
      "a transcript came back over a real websocket",
      socketWer <= MAX_WORD_ERROR_RATE,
      `wer ${socketWer.toFixed(3)} over ws://127.0.0.1:${socket.port}/v1/socket`,
    );
    unproven(
      "the daemon's own Supervisor.prompt handoff",
      "this run used a synthetic agent id, so the daemon logged " +
        "voice_prompt_failed instead of starting a turn; proving it needs a " +
        "live agent, which spawns omp acp and bills a model turn",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    console.log(`removed ${home}: ${!existsSync(home)}`);
  }
} catch (err) {
  failed = true;
  if (err instanceof PrerequisiteError) {
    console.error(`\nstopped: ${err.message}`);
  } else {
    console.error(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`);
  }
} finally {
  // -- stage 6 --------------------------------------------------------------
  heading("stage 6: cleanup");
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`removed ${scratch}: ${!existsSync(scratch)}`);
  }
}

heading("summary");
for (const result of results) {
  console.log(`${result.status.padEnd(9)} ${result.name} -- ${result.detail}`);
}
const unprovenLegs = results.filter((result) => result.status === "UNPROVEN");
if (failed) {
  console.log("\nVOICE LOOP NOT PROVEN");
} else if (unprovenLegs.length > 0) {
  // Never "PROVEN" while a leg is knowingly untested. The headline is the
  // only line most people read, and it must not claim more than the run did.
  console.log("\nVOICE LOOP PARTIAL: every exercised leg passed, but these were not exercised:");
  for (const leg of unprovenLegs) console.log(`  - ${leg.name}: ${leg.detail}`);
} else {
  console.log("\nVOICE LOOP PROVEN");
}
process.exit(failed ? 1 : 0);
