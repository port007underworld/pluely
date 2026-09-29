import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import moment from "moment";
import { MEETING_NOTES_PROMPT } from "@/config";
import { appendMessages } from "@/lib/database/chat-history.action";
import { generateConversationId, generateMessageId, MESSAGE_ID_OFFSET } from "@/lib/chat-constants";
import { TYPE_PROVIDER } from "@/types";
import { fetchAIResponse } from "./ai-response.function";
import { getSpeakerNames, speakerDisplayName, speakerNamesLegend } from "../storage/speaker-names.storage";

export interface MeetingSession {
  startedMs: number;
  endedMs?: number;
  segments: { source: "system" | "mic"; speaker?: string; startMs: number; endMs: number; text: string }[];
}

export interface MeetingNotesSaved {
  conversationId: string;
  title: string;
}

/** Sent to every window when notes are saved, so lists can refresh. */
export const MEETING_NOTES_SAVED_EVENT = "meeting-notes-saved";

/** Meetings shorter than this, or with fewer lines, don't get notes. */
export const MIN_NOTES_DURATION_MS = 2 * 60 * 1000;
export const MIN_NOTES_SEGMENTS = 8;

/** Very long meetings are trimmed from the middle to keep the request reasonable. */
const MAX_TRANSCRIPT_CHARS = 300_000;

export function formatSessionTranscript(session: MeetingSession): string {
  const names = getSpeakerNames();
  const lines = session.segments.map((s) => {
    const who = s.source === "mic" ? "You" : speakerDisplayName(s.speaker ?? "Them", names);
    return `[${moment(s.startMs).format("HH:mm:ss")}] ${who}: ${s.text.trim()}`;
  });
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const half = MAX_TRANSCRIPT_CHARS / 2;
    text = `${text.slice(0, half)}\n[… middle of the meeting omitted for length …]\n${text.slice(-half)}`;
  }
  const hasMic = session.segments.some((s) => s.source === "mic");
  const legend = [
    hasMic
      ? '"You" is the user; everyone else is another participant.'
      : "Only the other participants were recorded; the user's own voice is not in the transcript.",
    speakerNamesLegend(names),
  ]
    .filter(Boolean)
    .join(" ");
  return `<meeting_transcript started="${moment(session.startedMs).format("LLLL")}">\nLegend: ${legend}\n${text}\n</meeting_transcript>`;
}

/**
 * Generate notes for the current or most recent Meeting mode session and save
 * them as a new conversation (the transcript is saved with them).
 */
export async function generateMeetingNotes({
  provider,
  selectedProvider,
  signal,
}: {
  provider: TYPE_PROVIDER;
  selectedProvider: { provider: string; variables: Record<string, string> };
  signal?: AbortSignal;
}): Promise<MeetingNotesSaved> {
  const session = await invoke<MeetingSession>("live_transcript_session");
  if (session.segments.length === 0) {
    throw new Error("Nothing was transcribed in this meeting yet.");
  }

  const userMessage = `${MEETING_NOTES_PROMPT}\n\n${formatSessionTranscript(session)}`;
  const vars = { ...selectedProvider.variables };
  delete vars.slow_model;

  let notes = "";
  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider: { ...selectedProvider, variables: vars },
    userMessage,
    signal,
  })) {
    notes += chunk;
  }
  if (!notes.trim()) throw new Error("The AI provider returned empty notes.");

  const timestamp = Date.now();
  const conversationId = generateConversationId("chat");
  const title = `Meeting notes · ${moment(session.startedMs).format("ddd MMM D, h:mm A")}`;
  await appendMessages({ id: conversationId, title, createdAt: session.startedMs }, [
    { id: generateMessageId("user", timestamp), role: "user", content: userMessage, timestamp },
    {
      id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
      role: "assistant",
      content: notes,
      timestamp: timestamp + MESSAGE_ID_OFFSET,
    },
  ]);

  const saved = { conversationId, title };
  await emit(MEETING_NOTES_SAVED_EVENT, saved).catch(() => {});
  return saved;
}
