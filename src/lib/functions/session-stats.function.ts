import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SpeakerStats {
  /** "You" for the microphone, otherwise "Speaker N" or "Them". */
  label: string;
  source: "system" | "mic";
  lines: number;
  words: number;
  talkMs: number;
  lastText: string;
}

export interface SessionStats {
  startedMs: number;
  endedMs?: number;
  speakers: SpeakerStats[];
}

/** Per-speaker totals for the current or last meeting, refreshed while mounted. */
export const useSessionStats = (enabled: boolean, intervalMs = 3000) => {
  const [stats, setStats] = useState<SessionStats | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const poll = () =>
      invoke<SessionStats>("live_transcript_stats")
        .then((next) => active && setStats(next))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
  return stats;
};
