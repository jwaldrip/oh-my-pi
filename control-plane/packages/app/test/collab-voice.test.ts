import { describe, expect, test } from "bun:test";
import type { CollabVoiceFrame, CollabVoiceNoteFrame } from "@ompd/core/contracts";
import { CollabVoiceQueue, type CollabAudioPlayer } from "../src/voice/collab-voice.ts";

const ROOM_ID = "room_0123456789";

function note(id: string, sequence: number, kind: "human" | "agent"): CollabVoiceNoteFrame {
  return {
    t: "collab_voice_note",
    roomId: ROOM_ID,
    noteId: id,
    sequence,
    createdAt: `2026-08-13T12:00:0${sequence}.000Z`,
    participant: { id: `${kind}_${id}`, kind, displayName: kind === "human" ? "Jason" : "OMP" },
    audio: { pcm: "AAE=", encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
  };
}

describe("CollabVoiceQueue", () => {
  test("plays human and agent notes once in room sequence order", async () => {
    const player = new RecordingPlayer();
    const queue = new CollabVoiceQueue(player);

    expect(queue.enqueue(note("agent-later", 2, "agent"))).toBe(true);
    expect(queue.enqueue(note("human-first", 1, "human"))).toBe(true);
    expect(queue.enqueue(note("agent-later", 2, "agent"))).toBe(false);

    await queue.whenIdle();
    expect(player.played.map(({ noteId, participant }) => `${participant.kind}:${noteId}`)).toEqual([
      "human:human-first",
      "agent:agent-later",
    ]);
  });

  test("does not feed live mixing frames into the sequential voice-note player", async () => {
    const player = new RecordingPlayer();
    const queue = new CollabVoiceQueue(player);
    const mix: CollabVoiceFrame = {
      t: "collab_voice_mix",
      roomId: ROOM_ID,
      mixId: "mix_0123456789",
      createdAt: "2026-08-13T12:00:00.000Z",
      sequence: 1,
      format: { encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
      tracks: [
        { participant: { id: "human_1", kind: "human", displayName: "Jason" }, pcm: "AAE=" },
        { participant: { id: "agent_1", kind: "agent", displayName: "OMP" }, pcm: "AAE=" },
      ],
    };

    expect(queue.enqueue(mix)).toBe(false);
    await queue.whenIdle();
    expect(player.played).toEqual([]);
  });
});

class RecordingPlayer implements CollabAudioPlayer {
  readonly played: CollabVoiceNoteFrame[] = [];

  async play(frame: CollabVoiceNoteFrame): Promise<void> {
    this.played.push(frame);
  }
}
