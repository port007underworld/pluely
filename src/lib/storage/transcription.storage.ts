import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";

/**
 * How captured meeting audio reaches the AI model:
 * - local: transcribed on this device with Whisper (private, free)
 * - cloud: transcribed by the speech-to-text provider configured in Dev Space
 * - raw:   the audio file itself is attached (only audio-capable AI providers)
 */
export type TranscriptionEngine = "local" | "cloud" | "raw";

export interface TranscriptionConfig {
  engine: TranscriptionEngine;
  localModel: string;
  /** Whisper language code, or "auto". Only used by multilingual models. */
  language: string;
  /** Also record the microphone so the user's own speech is labelled "You". */
  captureMic: boolean;
  /** Local engine only: transcribe continuously in the background. */
  live: boolean;
  /** How much live transcript a shortcut press sends. */
  transcriptWindowSeconds: number;
  /** Live + macOS: label distinct remote voices "Speaker 1", "Speaker 2"... */
  separateSpeakers: boolean;
  /** Live only: answer questions from other participants without a shortcut press. */
  autoAnswer: boolean;
  /** Include a screenshot with automatic answers. */
  autoAnswerScreenshot: boolean;
  /** Silence after a question before answering, so a longer question isn't cut off. */
  autoAnswerDelayMs: number;
  /** Don't auto-answer greetings, logistics and check-ins ("how are you?", "can you see my screen?"). */
  autoAnswerSkipSmallTalk: boolean;
  /** Write meeting notes from the live transcript when Meeting mode is turned off. */
  meetingNotes: boolean;
}

export const TRANSCRIPT_WINDOWS = [30, 60, 120, 300, 600];
export const AUTO_ANSWER_DELAYS = [1000, 2000, 3000, 5000];

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  engine: "local",
  localModel: "base.en",
  language: "auto",
  captureMic: false,
  live: true,
  transcriptWindowSeconds: 300,
  separateSpeakers: false,
  autoAnswer: false,
  autoAnswerScreenshot: false,
  autoAnswerDelayMs: 2000,
  autoAnswerSkipSmallTalk: true,
  meetingNotes: false,
};

const CHANGE_EVENT = "transcription-config-changed";

export const getTranscriptionConfig = (): TranscriptionConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.TRANSCRIPTION_CONFIG);
    if (!stored) return DEFAULT_TRANSCRIPTION_CONFIG;
    const parsed = JSON.parse(stored);
    return {
      engine: ["local", "cloud", "raw"].includes(parsed.engine)
        ? parsed.engine
        : DEFAULT_TRANSCRIPTION_CONFIG.engine,
      localModel:
        typeof parsed.localModel === "string" && parsed.localModel
          ? parsed.localModel
          : DEFAULT_TRANSCRIPTION_CONFIG.localModel,
      language:
        typeof parsed.language === "string" && parsed.language
          ? parsed.language
          : DEFAULT_TRANSCRIPTION_CONFIG.language,
      captureMic:
        typeof parsed.captureMic === "boolean"
          ? parsed.captureMic
          : DEFAULT_TRANSCRIPTION_CONFIG.captureMic,
      live:
        typeof parsed.live === "boolean" ? parsed.live : DEFAULT_TRANSCRIPTION_CONFIG.live,
      transcriptWindowSeconds: TRANSCRIPT_WINDOWS.includes(parsed.transcriptWindowSeconds)
        ? parsed.transcriptWindowSeconds
        : DEFAULT_TRANSCRIPTION_CONFIG.transcriptWindowSeconds,
      separateSpeakers:
        typeof parsed.separateSpeakers === "boolean"
          ? parsed.separateSpeakers
          : DEFAULT_TRANSCRIPTION_CONFIG.separateSpeakers,
      autoAnswer: parsed.autoAnswer === true,
      autoAnswerScreenshot: parsed.autoAnswerScreenshot === true,
      autoAnswerDelayMs: AUTO_ANSWER_DELAYS.includes(parsed.autoAnswerDelayMs)
        ? parsed.autoAnswerDelayMs
        : DEFAULT_TRANSCRIPTION_CONFIG.autoAnswerDelayMs,
      autoAnswerSkipSmallTalk: parsed.autoAnswerSkipSmallTalk !== false,
      meetingNotes: parsed.meetingNotes === true,
    };
  } catch {
    return DEFAULT_TRANSCRIPTION_CONFIG;
  }
};

export const setTranscriptionConfig = (
  update: Partial<TranscriptionConfig>
): TranscriptionConfig => {
  const next = { ...getTranscriptionConfig(), ...update };
  try {
    localStorage.setItem(STORAGE_KEYS.TRANSCRIPTION_CONFIG, JSON.stringify(next));
  } catch (error) {
    console.error("Failed to save transcription config:", error);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
};

/** Live view of the config; also follows changes made in other app windows. */
export const useTranscriptionConfig = () => {
  const [config, setConfig] = useState(getTranscriptionConfig);

  useEffect(() => {
    const refresh = () => setConfig(getTranscriptionConfig());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.TRANSCRIPTION_CONFIG) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return [config, setTranscriptionConfig] as const;
};
