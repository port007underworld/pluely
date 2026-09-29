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
  longestMonologueMs: number;
  currentMonologueMs: number;
}

export interface TalkSummary {
  youMs: number;
  othersMs: number;
  /** Your share of all talking, 0–1; null until anyone has spoken. */
  youShare: number | null;
  /** Your speaking pace in words per minute; null with too little speech to tell. */
  wordsPerMinute: number | null;
  longestMonologueMs: number;
  currentMonologueMs: number;
  /** Whether your microphone is in the transcript at all. */
  hasYou: boolean;
}

/** Speaking faster than this is hard to follow. */
export const FAST_PACE_WPM = 170;
/** A stretch of talking longer than this is worth a nudge. */
export const LONG_MONOLOGUE_MS = 90_000;

export function summarizeTalk(stats: SessionStats): TalkSummary {
  const you = stats.speakers.find((s) => s.source === "mic");
  const youMs = you?.talkMs ?? 0;
  const othersMs = stats.speakers
    .filter((s) => s.source === "system")
    .reduce((sum, s) => sum + s.talkMs, 0);
  const total = youMs + othersMs;
  return {
    youMs,
    othersMs,
    youShare: total > 0 ? youMs / total : null,
    wordsPerMinute: you && youMs >= 20_000 ? Math.round(you.words / (youMs / 60_000)) : null,
    longestMonologueMs: stats.longestMonologueMs,
    currentMonologueMs: stats.currentMonologueMs,
    hasYou: Boolean(you),
  };
}

export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

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
