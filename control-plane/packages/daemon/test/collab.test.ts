import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, SCOPE_PROMPT, SCOPE_READ, Store, type ServerFrame } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const ROOM_ID = "room_0123456789";
const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

interface CollabClient {
  frames: ServerFrame[];
  send(frame: unknown): void;
}

async function fixture(): Promise<{ gateway: Gateway; connect(id: string, scopes: string[]): CollabClient }> {
  const path = `/tmp/ompd-collab-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: createFakeHost().factory });
  const gateway = new Gateway({
    supervisor: new Supervisor({
      store,
      policy: new DefaultPolicy({ mode: "standard" }),
      approvalTimeoutMs: 500,
      spawnHost: hosts.spawn,
      events,
    }),
    store,
    events,
    port: 0,
    sessions: hosts,
  });
  gateways.push(gateway);
  await gateway.listen();

  return {
    gateway,
    connect(id, scopes) {
      store.addDevice({ id, name: id, publicKey: `pk_${id}`, scopes, createdAt: new Date().toISOString() });
      const token = gateway.issueToken(id);
      const frames: ServerFrame[] = [];
      const session = gateway.acceptTunnelSession(token, (raw) => frames.push(JSON.parse(raw) as ServerFrame));
      if (!session.ok) throw new Error(`failed to open test session for ${id}`);
      return { frames, send: (frame) => session.deliver(JSON.stringify(frame)) };
    },
  };
}

function voiceNote(noteId: string): object {
  return {
    t: "collab_voice_note",
    roomId: ROOM_ID,
    noteId,
    durationMs: 100,
    audio: { pcm: "AAE=", encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
  };
}

function notes(frames: readonly ServerFrame[]): Extract<ServerFrame, { t: "collab_voice_note" }>[] {
  return frames.filter((frame): frame is Extract<ServerFrame, { t: "collab_voice_note" }> => frame.t === "collab_voice_note");
}

describe("collaboration room gateway", () => {
  test("routes WebRTC signaling to its intended authenticated participant and fans human plus agent notes in durable order", async () => {
    const { gateway, connect } = await fixture();
    const alice = connect("dev_alice", [SCOPE_READ, SCOPE_PROMPT]);
    const bob = connect("dev_bob", [SCOPE_READ, SCOPE_PROMPT]);
    alice.send({ t: "room_join", roomId: ROOM_ID });
    bob.send({ t: "room_join", roomId: ROOM_ID });

    alice.send({ t: "room_offer", roomId: ROOM_ID, targetParticipantId: "dev_bob", sdp: "offer-sdp" });
    const offer = bob.frames.find((frame) => frame.t === "room_offer");
    expect(offer).toEqual({ t: "room_offer", roomId: ROOM_ID, from: { id: "dev_alice", kind: "human" }, sdp: "offer-sdp" });
    expect(alice.frames.some((frame) => frame.t === "room_offer")).toBe(false);

    alice.send(voiceNote("note_alice"));
    bob.send(voiceNote("note_bob"));
    gateway.publishCollabAgentVoiceNote(
      ROOM_ID,
      { id: "agent_omp", kind: "agent", displayName: "OMP" },
      {
        noteId: "note_agent",
        durationMs: 100,
        audio: { pcm: "AAE=", encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
      },
    );

    for (const client of [alice, bob]) {
      expect(notes(client.frames).map((frame) => [frame.sequence, frame.participant.kind, frame.noteId])).toEqual([
        [1, "human", "note_alice"],
        [2, "human", "note_bob"],
        [3, "agent", "note_agent"],
      ]);
    }

    const reconnectingBob = connect("dev_bob_reconnected", [SCOPE_READ, SCOPE_PROMPT]);
    reconnectingBob.send({ t: "room_join", roomId: ROOM_ID });
    const history = reconnectingBob.frames.find((frame) => frame.t === "collab_voice_history");
    expect(history?.notes.map((frame) => [frame.sequence, frame.noteId, frame.audio.pcm])).toEqual([
      [1, "note_alice", "AAE="],
      [2, "note_bob", "AAE="],
      [3, "note_agent", "AAE="],
    ]);
  });

  test("does not let a read-only participant establish an audio-capable WebRTC peer connection", async () => {
    const { connect } = await fixture();
    const reader = connect("dev_reader", [SCOPE_READ]);
    reader.send({ t: "room_join", roomId: ROOM_ID });
    reader.send({ t: "room_offer", roomId: ROOM_ID, targetParticipantId: "dev_nobody", sdp: "offer-sdp" });

    expect(reader.frames.at(-1)).toMatchObject({
      t: "error",
      code: "unauthorized",
      message: "room signaling requires prompt scope",
    });
  });
});
