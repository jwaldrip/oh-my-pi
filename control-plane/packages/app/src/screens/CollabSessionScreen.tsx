/**
 * A room opened from a collaboration link.
 *
 * The deep link names a room, not a capability. The paired-device connection
 * supplies authority, and the daemon is the source of participant identity.
 */

import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { CollabVoiceNoteFrame, CollabVoiceParticipant } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { Connection } from "../platform/connection.ts";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { createOmpdClient } from "../console/useConsole.ts";
import { CollabVoiceQueue, type CollabAudioPlayer } from "../voice/collab-voice.ts";

const defaultAudioPlayer: CollabAudioPlayer = {
  play: async () => {},
};
export function CollabSessionScreen({
  roomId,
  connection,
  player,
  onClose,
}: {
  roomId: string;
  connection: Connection;
  player?: CollabAudioPlayer;
  onClose: () => void;
}): JSX.Element {
  const client = useMemo(() => createOmpdClient(connection), [connection]);
  const [participants, setParticipants] = useState<readonly CollabVoiceParticipant[]>([]);
  const [voiceNotes, setVoiceNotes] = useState<readonly CollabVoiceNoteFrame[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const voiceQueue = useMemo(() => new CollabVoiceQueue(player ?? defaultAudioPlayer), [player]);
  useEffect(() => {
    const offStatus = client.on("status", ({ state }) => setConnectionState(state));
    const offParticipants = client.on("room_participants", (event) => {
      if (event.roomId === roomId) setParticipants(event.participants);
    });
    const offVoice = client.on("collab_voice", (event) => {
      const frame = event.frame;
      if (frame.roomId === roomId && frame.t === "collab_voice_note") {
        voiceQueue.enqueue(frame);
        setVoiceNotes((prev) => (prev.some((n) => n.noteId === frame.noteId) ? prev : [...prev, frame]));
      }
    });
    const offHistory = client.on("collab_voice_history", (event) => {
      if (event.roomId === roomId) {
        for (const note of event.notes) voiceQueue.enqueue(note);
        setVoiceNotes(event.notes);
      }
    });
    const offError = client.on("error", (event) => setNotice(event.message));

    client.start();
    client.joinRoom(roomId);
    return () => {
      client.leaveRoom(roomId);
      offStatus();
      offParticipants();
      offVoice();
      offHistory();
      offError();
      client.close();
    };
  }, [client, roomId]);

  return (
    <SafeScreen style={styles.screen} testID="collab-session">
      <View style={styles.header}>
        <View style={styles.heading}>
          <Kicker color={ink.muted}>Collaboration</Kicker>
          <Display heading>Shared room</Display>
        </View>
        <Pressable
          accessibilityLabel="Return to sessions"
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
        >
          <Label color={ink.plain}>Sessions</Label>
        </Pressable>
      </View>

      <View style={styles.room}>
        <Kicker color={ink.muted}>Room ID</Kicker>
        <Body color={ink.bright} style={type.code} testID="collab-room-id">
          {roomId}
        </Body>
        <Label color={connectionState === "connected" ? signal.sage : ink.muted} testID="collab-connection-state">
          {connectionState === "connected" ? "Connected" : "Connecting to the daemon"}
        </Label>
      </View>

      {notice === null ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite" testID="collab-notice">
          <Body color={signal.ochre}>{notice}</Body>
        </View>
      )}

      <View style={styles.section} testID="collab-participants">
        <Kicker color={ink.muted}>In this room</Kicker>
        {participants.length === 0 ? (
          <Body color={ink.muted}>Waiting for a participant.</Body>
        ) : (
          participants.map((participant) => (
            <View key={participant.id} style={styles.row}>
              <Label color={ink.bright}>{participant.displayName}</Label>
              <Label color={ink.muted}>{participant.kind === "agent" ? "Agent" : "Human"}</Label>
            </View>
          ))
        )}
      </View>

      <View style={styles.section} testID="collab-voice-notes">
        <Kicker color={ink.muted}>Voice Notes ({voiceNotes.length})</Kicker>
        {voiceNotes.length === 0 ? (
          <Body color={ink.muted}>No voice notes in this room yet.</Body>
        ) : (
          voiceNotes.map((note) => (
            <View key={note.noteId} style={styles.row}>
              <View style={styles.noteMeta}>
                <Label color={note.participant.kind === "agent" ? signal.sage : ink.bright}>
                  #{note.sequence} {note.participant.displayName}
                </Label>
                <Label color={ink.muted}>{note.durationMs ? `${note.durationMs}ms` : "audio"}</Label>
              </View>
            </View>
          ))
        )}
      </View>
    </SafeScreen>
  );
}
const styles = StyleSheet.create({
  screen: { gap: space.loose, padding: space.loose },
  header: { alignItems: "flex-start", flexDirection: "row", gap: space.step, justifyContent: "space-between" },
  heading: { flex: 1, gap: space.tight },
  close: {
    alignItems: "center",
    borderColor: ground.line,
    borderWidth: stroke.hair,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  closePressed: { backgroundColor: ground.active },
  room: { backgroundColor: ground.surface, gap: space.tight, padding: space.step },
  notice: { backgroundColor: signalWash.ochre, padding: space.step },
  section: { gap: space.tight },
  row: {
    alignItems: "center",
    borderBottomColor: ground.line,
    borderBottomWidth: stroke.hair,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: TOUCH_TARGET,
  },
  noteMeta: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
