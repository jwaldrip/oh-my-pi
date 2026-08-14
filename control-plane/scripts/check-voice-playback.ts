#!/usr/bin/env bun
/**
 * Prove the leg `check-voice-loop.ts` cannot: that a browser plays the answer.
 *
 * The input leg has its own proof. This one exists because "the daemon emitted
 * a speech frame" and "a person heard the reply" are different claims, and
 * only the second one is what bi-directional voice means. Everything a browser
 * needs in order to be caught lying is here: the frame has to arrive at a real
 * page, decode to real samples, reach a real `AudioContext`, and finish
 * playing in real time.
 *
 * This script stands the daemon up and puts everything the browser needs where
 * the browser can reach it. Driving Chrome is the caller's job, because a
 * headless browser that cannot make sound is not evidence of anything.
 *
 *   bun run scripts/check-voice-playback.ts
 *
 * It prints one JSON line, then serves until killed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ompd } from "../packages/daemon/src/daemon.ts";
import {
  pcmToBase64,
  selectTtsEngine,
  speakableSegments,
} from "../packages/daemon/src/voice/index.ts";

/**
 * Short, unambiguous, and nothing like a hallucination. The agent's reply is
 * whatever the model says; only the daemon speaking it back is under test.
 */
const SPOKEN_PROMPT = "Reply with exactly the words green light and nothing else.";

const home = mkdtempSync(join(tmpdir(), "ompd-playback-"));
const dist = resolve(import.meta.dir, "../packages/web/dist");
const promptFile = join(dist, "spoken-prompt.b64");

const daemon = new Ompd({
  home,
  overrides: { port: 0 },
  repoRoot: home,
  onLog: (line) => console.error(`[daemon] ${line}`),
});

const info = await daemon.start();
const token = (await Bun.file(join(home, "token")).text()).trim();

// Synthesised with the same engine the daemon speaks through, so the audio the
// browser sends up is real speech from this machine rather than a fixture
// recorded somewhere else.
const tts = await selectTtsEngine();
if (tts.name === "null") {
  console.error("no text-to-speech engine; run `omp setup speech` to download the voice model");
  process.exit(1);
}
// Drained into one payload because the browser sends it up as a single
// utterance. The daemon's own reply is where streaming matters, and that leg
// is what this script is here to watch.
const chunks: Int16Array[] = [];
for await (const chunk of tts.stream(speakableSegments(SPOKEN_PROMPT))) chunks.push(chunk.pcm);
let total = 0;
for (const chunk of chunks) total += chunk.length;
const spokenPcm = new Int16Array(total);
let offset = 0;
for (const chunk of chunks) {
  spokenPcm.set(chunk, offset);
  offset += chunk.length;
}

// Served from the web root because the page has to fetch it: a base64 payload
// this size does not belong inlined in an evaluate call.
writeFileSync(promptFile, pcmToBase64(spokenPcm));

const created = await fetch(`${info.url}/v1/agents`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "playback", cwd: home }),
});
if (created.status !== 201) {
  console.error(`could not create an agent: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { agent } = (await created.json()) as { agent: { id: string } };

console.log(
  JSON.stringify({
    url: info.url,
    token,
    agentId: agent.id,
    ttsEngine: tts.name,
    promptSamples: spokenPcm.length,
    home,
  }),
);

const cleanup = async (): Promise<void> => {
  rmSync(promptFile, { force: true });
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void cleanup());
process.once("SIGTERM", () => void cleanup());

// Serve until killed. The browser needs the daemon alive for the whole run.
await Promise.withResolvers<void>().promise;
