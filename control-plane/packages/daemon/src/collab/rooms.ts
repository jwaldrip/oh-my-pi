/**
 * Authenticated collaboration rooms.
 *
 * The hub carries the encrypted gateway websocket unchanged. This registry runs
 * after gateway authentication, so a participant id always comes from the
 * paired device rather than a client frame. Room membership is deliberately
 * ephemeral, while completed note audio and its sequence are committed to the
 * daemon store before any peer receives a broadcast.
 */

import type {
  Actor,
  CollabSignalInput,
  CollabSignalFrame,
  CollabVoiceNoteFrame,
  CollabVoiceNoteInput,
  CollabVoiceParticipant,
  PersistCollabVoiceNoteInput,
  ServerFrame,
  Store,
} from "@ompd/core";

const ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SIGNAL_CHARS = 256_000;
const MAX_AUDIO_BASE64_CHARS = 1_400_000;

export class CollabRoomError extends Error {
  readonly code: "bad_frame" | "room_not_joined" | "room_participant_unavailable";

  constructor(code: CollabRoomError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CollabConnection {
  readonly actor: Actor;
  send(frame: ServerFrame): void;
}

interface RoomMember {
  connection: CollabConnection;
  participant: CollabVoiceParticipant;
}

/**
 * One daemon's live room membership and fan-out. A room cannot outlive this
 * daemon's connections, but its completed notes can, because the Store owns
 * their replay log.
 */
export class CollabRooms {
  readonly #store: Store;
  readonly #rooms = new Map<string, Map<string, RoomMember>>();

  constructor(store: Store) {
    this.#store = store;
  }

  join(roomId: string, connection: CollabConnection): void {
    this.#requireRoomId(roomId);
    let room = this.#rooms.get(roomId);
    if (room === undefined) {
      room = new Map();
      this.#rooms.set(roomId, room);
    }

    const participant: CollabVoiceParticipant = { id: connection.actor.deviceId, kind: "human" };
    room.set(participant.id, { connection, participant });
    connection.send({ t: "collab_voice_history", roomId, notes: this.#store.listCollabVoiceNotes(roomId) });
    this.#broadcastParticipants(roomId, room);
  }

  leave(roomId: string, connection: CollabConnection): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;

    const member = room.get(connection.actor.deviceId);
    // A stale socket closing must not evict the newer connection for the same
    // paired device.
    if (member?.connection !== connection) return;
    room.delete(connection.actor.deviceId);
    if (room.size === 0) {
      this.#rooms.delete(roomId);
      return;
    }
    this.#broadcastParticipants(roomId, room);
  }

  leaveAll(connection: CollabConnection): void {
    for (const roomId of this.#rooms.keys()) this.leave(roomId, connection);
  }

  relaySignal(input: CollabSignalInput, connection: CollabConnection): void {
    const room = this.#memberRoom(input.roomId, connection);
    this.#requireSignal(input);
    const from = room.get(connection.actor.deviceId)?.participant;
    const target = room.get(input.targetParticipantId);
    if (from === undefined || target === undefined) {
      throw new CollabRoomError("room_participant_unavailable", "the requested room participant is unavailable");
    }

    let frame: CollabSignalFrame;
    switch (input.t) {
      case "room_offer":
        frame = { t: "room_offer", roomId: input.roomId, from, sdp: input.sdp };
        break;
      case "room_answer":
        frame = { t: "room_answer", roomId: input.roomId, from, sdp: input.sdp };
        break;
      case "ice_candidate":
        frame = {
          t: "ice_candidate",
          roomId: input.roomId,
          from,
          candidate: input.candidate,
          ...(input.sdpMid === undefined ? {} : { sdpMid: input.sdpMid }),
          ...(input.sdpMLineIndex === undefined ? {} : { sdpMLineIndex: input.sdpMLineIndex }),
        };
        break;
    }
    target.connection.send(frame);
  }

  /**
   * Commits a human PTT note before broadcasting it to every current member.
   * A note id retry returns the original sequence without a second broadcast.
   */
  publishVoiceNote(input: CollabVoiceNoteInput, connection: CollabConnection): CollabVoiceNoteFrame {
    const room = this.#memberRoom(input.roomId, connection);
    this.#requireVoiceNote(input);
    const participant = room.get(connection.actor.deviceId)?.participant;
    if (participant === undefined) throw new CollabRoomError("room_not_joined", "join the room before sending audio");

    const stored = this.#store.recordCollabVoiceNote({
      roomId: input.roomId,
      noteId: input.noteId,
      participant,
      audio: input.audio,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
    if (stored.inserted) this.#broadcast(room, stored.frame);
    return stored.frame;
  }

  /**
   * Daemon-owned agent audio uses the same durable path but cannot impersonate
   * a human participant. The composition root may call this when an agent has
   * a complete audio note to contribute to an active room.
   */
  publishAgentVoiceNote(
    roomId: string,
    agent: CollabVoiceParticipant,
    input: Omit<PersistCollabVoiceNoteInput, "roomId" | "participant">,
  ): CollabVoiceNoteFrame {
    if (agent.kind !== "agent") throw new CollabRoomError("bad_frame", "agent voice must name an agent participant");
    this.#requireRoomId(roomId);
    const room = this.#rooms.get(roomId);
    if (room === undefined) throw new CollabRoomError("room_not_joined", "the room has no live participants");
    this.#requireVoiceNote({ t: "collab_voice_note", roomId, ...input });

    const stored = this.#store.recordCollabVoiceNote({ roomId, participant: agent, ...input });
    if (stored.inserted) this.#broadcast(room, stored.frame);
    return stored.frame;
  }

  #memberRoom(roomId: string, connection: CollabConnection): Map<string, RoomMember> {
    this.#requireRoomId(roomId);
    const room = this.#rooms.get(roomId);
    if (room === undefined || room.get(connection.actor.deviceId)?.connection !== connection) {
      throw new CollabRoomError("room_not_joined", "join the room before sending room traffic");
    }
    return room;
  }

  #broadcastParticipants(roomId: string, room: Map<string, RoomMember>): void {
    const participants = [...room.values()].map(({ participant }) => participant);
    this.#broadcast(room, { t: "room_participants", roomId, participants });
  }

  #broadcast(room: Map<string, RoomMember>, frame: ServerFrame): void {
    for (const { connection } of room.values()) connection.send(frame);
  }

  #requireRoomId(roomId: string): void {
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) {
      throw new CollabRoomError("bad_frame", "roomId must be a 10 to 64 character base64url id");
    }
  }

  #requireSignal(input: CollabSignalInput): void {
    if (typeof input.targetParticipantId !== "string" || input.targetParticipantId.length === 0 || input.targetParticipantId.length > 256) {
      throw new CollabRoomError("bad_frame", "room signaling target is invalid");
    }

    const payload = input.t === "ice_candidate" ? input.candidate : input.sdp;
    if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_SIGNAL_CHARS) {
      throw new CollabRoomError("bad_frame", "room signaling payload is invalid or too large");
    }
    if (input.t === "ice_candidate") {
      if (input.sdpMid !== undefined && typeof input.sdpMid !== "string") {
        throw new CollabRoomError("bad_frame", "ICE candidate media id must be text");
      }
      if (input.sdpMLineIndex !== undefined && !Number.isInteger(input.sdpMLineIndex)) {
        throw new CollabRoomError("bad_frame", "ICE candidate line index must be an integer");
      }
    }
  }

  #requireVoiceNote(input: CollabVoiceNoteInput): void {
    if (typeof input.noteId !== "string" || !NOTE_ID.test(input.noteId)) {
      throw new CollabRoomError("bad_frame", "noteId must be a plain identifier");
    }
    const audio = input.audio as unknown;
    if (typeof audio !== "object" || audio === null) {
      throw new CollabRoomError("bad_frame", "voice-note audio is missing");
    }
    const record = audio as Record<string, unknown>;
    if (
      typeof record.pcm !== "string" ||
      record.pcm.length === 0 ||
      record.pcm.length > MAX_AUDIO_BASE64_CHARS ||
      record.encoding !== "pcm_s16le" ||
      typeof record.sampleRateHz !== "number" ||
      !Number.isInteger(record.sampleRateHz) ||
      record.sampleRateHz < 8_000 ||
      record.sampleRateHz > 96_000 ||
      (record.channels !== 1 && record.channels !== 2) ||
      (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 0))
    ) {
      throw new CollabRoomError("bad_frame", "voice-note audio is invalid or too large");
    }
  }
}
