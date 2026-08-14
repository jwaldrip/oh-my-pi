/**
 * Ordered playback for finished collaboration voice notes.
 *
 * Live `collab_voice_mix` frames belong to a low-latency mixer. They must never
 * enter this queue, where waiting behind a complete note would turn a live call
 * into stale audio. Finished notes are durable, room-sequenced artifacts and
 * are played one at a time in that sequence.
 */

import type { CollabVoiceFrame, CollabVoiceNoteFrame } from "@ompd/core";

export interface CollabAudioPlayer {
  play(frame: CollabVoiceNoteFrame): Promise<void>;
}

export class CollabVoiceQueue {
  readonly #player: CollabAudioPlayer;
  readonly #seen = new Set<string>();
  readonly #pending: CollabVoiceNoteFrame[] = [];
  readonly #idle = new Set<() => void>();
  #scheduled = false;
  #playing = false;

  constructor(player: CollabAudioPlayer) {
    this.#player = player;
  }

  /**
   * Accept one complete note. A duplicate is never replayed, even after a
   * reconnect repeats the frame, and a live mixing frame goes to its dedicated
   * realtime path instead.
   */
  enqueue(frame: CollabVoiceFrame): boolean {
    if (frame.t !== "collab_voice_note") return false;

    const identity = `${frame.roomId}:${frame.noteId}`;
    if (this.#seen.has(identity)) return false;
    this.#seen.add(identity);
    this.#pending.push(frame);
    this.#pending.sort((left, right) => left.sequence - right.sequence || left.noteId.localeCompare(right.noteId));
    this.#schedule();
    return true;
  }

  /** Resolves after all notes already accepted by the queue have been played. */
  whenIdle(): Promise<void> {
    if (!this.#scheduled && !this.#playing && this.#pending.length === 0) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#idle.add(waiter.resolve);
    return waiter.promise;
  }

  #schedule(): void {
    if (this.#scheduled || this.#playing) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#playing) return;
    this.#playing = true;
    try {
      let frame: CollabVoiceNoteFrame | undefined;
      while ((frame = this.#pending.shift()) !== undefined) await this.#player.play(frame);
    } finally {
      this.#playing = false;
      if (this.#pending.length > 0) {
        this.#schedule();
      } else {
        for (const resolve of this.#idle) resolve();
        this.#idle.clear();
      }
    }
  }
}
