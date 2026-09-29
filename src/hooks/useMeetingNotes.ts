import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  generateMeetingNotes,
  MeetingNotesSaved,
  MeetingSession,
  MIN_NOTES_DURATION_MS,
  MIN_NOTES_SEGMENTS,
  resolveAIProvider,
  useTranscriptionConfig,
} from "@/lib";

export type MeetingNotesStatus =
  | { state: "idle" }
  | { state: "working" }
  | { state: "saved"; notes: MeetingNotesSaved }
  | { state: "error"; error: string };

/** Generate notes on demand; returns the status for display. */
export const useMeetingNotes = () => {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [status, setStatus] = useState<MeetingNotesStatus>({ state: "idle" });
  const busy = useRef(false);

  const generate = useCallback(async () => {
    if (busy.current) return;
    const resolved = resolveAIProvider(selectedAIProvider, allAiProviders);
    if ("error" in resolved) {
      setStatus({ state: "error", error: resolved.error });
      return;
    }
    busy.current = true;
    setStatus({ state: "working" });
    try {
      const notes = await generateMeetingNotes({
        provider: resolved.provider,
        selectedProvider: selectedAIProvider,
      });
      setStatus({ state: "saved", notes });
    } catch (e) {
      setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current = false;
    }
  }, [selectedAIProvider, allAiProviders]);

  return { status, generate };
};

/**
 * In the overlay window: write notes when Meeting mode ends, if the user turned
 * that on and the meeting was long enough to be worth it.
 */
export const useAutoMeetingNotes = () => {
  const [config] = useTranscriptionConfig();
  const { generate } = useMeetingNotes();
  const generateRef = useRef(generate);
  generateRef.current = generate;

  useEffect(() => {
    if (!config.meetingNotes || getCurrentWindow().label !== "main") return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<Omit<MeetingSession, "segments"> & { segmentCount: number }>(
      "meeting-ended",
      ({ payload }) => {
        const duration = (payload.endedMs ?? Date.now()) - payload.startedMs;
        if (payload.segmentCount >= MIN_NOTES_SEGMENTS && duration >= MIN_NOTES_DURATION_MS) {
          void generateRef.current();
        }
      }
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [config.meetingNotes]);
};
