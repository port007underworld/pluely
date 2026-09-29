import { invoke } from "@tauri-apps/api/core";
import { TYPE_PROVIDER } from "@/types";
import {
  getTranscriptionConfig,
  TranscriptionEngine,
} from "../storage/transcription.storage";
import { fetchSTT } from "./stt.function";
import {
  getSpeakerNames,
  SpeakerNames,
  speakerDisplayName,
  speakerNamesLegend,
} from "../storage/speaker-names.storage";

export interface TranscriptSegment {
  /** "system" = other participants (computer audio output), "mic" = the user. */
  source: "system" | "mic";
  /** Diarized label within a source, e.g. "Speaker 2". */
  speaker?: string;
  /** Seconds relative to capture time (negative = in the past). */
  startOffset?: number;
  endOffset?: number;
  text: string;
}

export interface MeetingAudioCapture {
  /** Raw OGG/Opus audio; only set when the raw engine (or fallback) is used. */
  audioBase64?: string;
  /** Transcript formatted for the model, ready to append to the prompt. */
  transcript?: string;
  segments: TranscriptSegment[];
  engineUsed: TranscriptionEngine | "none";
  /** User-facing, non-fatal problem (silence, missing model, STT failure...). */
  warning?: string;
  fetchMs: number;
}

interface LocalTranscriptResult {
  segments: TranscriptSegment[];
  text: string;
  silent: boolean;
  silenceRatio: number;
  micSilenceRatio: number | null;
  audioSeconds: number;
  durationMs: number;
}

const SILENT_RATIO = 0.97;

const silenceWarning = (seconds: number) =>
  `No audio was detected in the last ${seconds}s. Check that meeting audio is playing through this computer and that System Audio Recording permission is granted.`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const speakerLabel = (segment: TranscriptSegment, names: SpeakerNames) =>
  segment.source === "mic" ? "You" : speakerDisplayName(segment.speaker ?? "Them", names);

const formatOffset = (seconds: number) => {
  const total = Math.max(0, Math.round(-seconds));
  return total < 60
    ? `-${total}s`
    : `-${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
};

const formatWindow = (seconds: number) =>
  seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} min` : `${seconds}s`;

export function formatTranscriptForLLM(
  segments: TranscriptSegment[],
  windowSeconds: number
): string {
  const hasMic = segments.some((s) => s.source === "mic");
  const hasSpeakers = segments.some((s) => s.speaker);
  const others = hasSpeakers
    ? '"Speaker 1", "Speaker 2"… = distinct voices of other participants (computer audio), numbered per meeting; "Them" = a participant whose voice could not be identified.'
    : '"Them" = other participants (computer audio).';
  const names = getSpeakerNames();
  const legend = [
    hasMic ? `${others} "You" = the user (microphone).` : `${others} The user's own voice is not captured.`,
    speakerNamesLegend(names),
  ]
    .filter(Boolean)
    .join(" ");
  const lines = segments.map((s) => {
    const time = s.startOffset !== undefined ? `[${formatOffset(s.startOffset)}] ` : "";
    return `${time}${speakerLabel(s, names)}: ${s.text}`;
  });
  return [
    `<meeting_transcript window="last ${formatWindow(windowSeconds)}" order="oldest first">`,
    `Legend: ${legend} Timestamps are seconds before this message. Automatic transcription may contain errors.`,
    ...lines,
    "</meeting_transcript>",
  ].join("\n");
}

async function captureRaw(): Promise<string> {
  return invoke<string>("system_audio_get_recent_base64");
}

async function silenceRatio(seconds: number): Promise<number> {
  return invoke<number>("system_audio_silence_ratio", { seconds });
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Whether raw audio can go to the selected AI provider: it must have an
 * {{AUDIO}} slot in its curl.
 */
export async function aiProviderAcceptsAudio(provider?: TYPE_PROVIDER): Promise<boolean> {
  return Boolean(provider?.curl.includes("{{AUDIO}}"));
}

const NO_AUDIO_PROVIDER =
  "Your AI provider doesn't accept audio, so the screenshot was sent without meeting audio.";

/**
 * Raw audio attached as a fallback, with the reason surfaced to the user. Only
 * when the AI provider accepts audio: otherwise the whole request would fail,
 * so the screenshot goes out alone.
 */
async function fallbackToRaw(
  reason: string,
  started: number,
  aiAcceptsAudio: boolean
): Promise<MeetingAudioCapture> {
  if (!aiAcceptsAudio) {
    return {
      segments: [],
      engineUsed: "none",
      warning: `${reason} ${NO_AUDIO_PROVIDER}`,
      fetchMs: performance.now() - started,
    };
  }
  try {
    const audioBase64 = await captureRaw();
    return {
      audioBase64,
      segments: [],
      engineUsed: "raw",
      warning: `${reason} Sent the raw audio instead; it only works with audio-capable AI providers.`,
      fetchMs: performance.now() - started,
    };
  } catch (e) {
    return {
      segments: [],
      engineUsed: "none",
      warning: `${reason} (${errorMessage(e)})`,
      fetchMs: performance.now() - started,
    };
  }
}

/**
 * Grab the recent meeting audio in the form the user chose on the Meeting page.
 * Never throws: failures come back as `warning` so the screenshot request still goes out.
 */
export async function captureMeetingAudio(options: {
  windowSeconds: number;
  sttProvider?: TYPE_PROVIDER;
  sttSelection?: { provider: string; variables: Record<string, string> };
  /** Whether the selected AI provider takes audio input ({{AUDIO}} in its curl). */
  aiAcceptsAudio: boolean;
}): Promise<MeetingAudioCapture> {
  const { windowSeconds, sttProvider, sttSelection, aiAcceptsAudio } = options;
  const config = getTranscriptionConfig();
  const started = performance.now();
  const done = (
    result: Omit<MeetingAudioCapture, "fetchMs">
  ): MeetingAudioCapture => ({ ...result, fetchMs: performance.now() - started });

  try {
    if (config.engine === "local") {
      let result: LocalTranscriptResult | null = null;
      let window = windowSeconds;
      if (config.live) {
        // Already transcribed in the background; only the latest words are new work.
        try {
          result = await invoke<LocalTranscriptResult>("live_transcript_get", {
            windowSeconds: config.transcriptWindowSeconds,
          });
          window = config.transcriptWindowSeconds;
        } catch {
          result = null; // not running yet: fall back to on-demand below
        }
      }
      if (!result) {
        try {
          result = await invoke<LocalTranscriptResult>("local_stt_transcribe_recent", {
            modelId: config.localModel,
            language: config.language,
          });
        } catch (e) {
          return fallbackToRaw(
            `Local transcription unavailable: ${errorMessage(e)}.`,
            started,
            aiAcceptsAudio
          );
        }
      }
      const warning = result.silent ? silenceWarning(windowSeconds) : undefined;
      if (result.segments.length === 0) {
        return done({ segments: [], engineUsed: "local", warning });
      }
      return done({
        segments: result.segments,
        transcript: formatTranscriptForLLM(result.segments, window),
        engineUsed: "local",
        warning,
      });
    }

    if (config.engine === "cloud") {
      if (!sttProvider || !sttSelection?.provider) {
        return fallbackToRaw(
          "No cloud speech-to-text provider is selected (Dev Space > Speech-to-Text).",
          started,
          aiAcceptsAudio
        );
      }
      const transcribe = async (source: "system" | "mic") => {
        const prefix = source === "mic" ? "mic_audio" : "system_audio";
        const ratio = await invoke<number>(`${prefix}_silence_ratio`, {
          seconds: windowSeconds,
        });
        if (ratio >= SILENT_RATIO) return { silent: true, text: "" };
        const wav = await invoke<string>(`${prefix}_get_recent_wav_base64`, {
          seconds: windowSeconds,
        });
        const text = await fetchSTT({
          provider: sttProvider,
          selectedProvider: sttSelection,
          audio: base64ToBlob(wav, "audio/wav"),
        });
        const clean = text.trim();
        return {
          silent: false,
          text: clean === "No transcription found" ? "" : clean,
        };
      };

      let system: { silent: boolean; text: string };
      let mic: { silent: boolean; text: string } | null = null;
      try {
        system = await transcribe("system");
        if (config.captureMic && (await invoke<boolean>("mic_audio_is_recording"))) {
          mic = await transcribe("mic");
        }
      } catch (e) {
        return fallbackToRaw(
          `Cloud transcription failed: ${errorMessage(e)}.`,
          started,
          aiAcceptsAudio
        );
      }

      // Cloud providers return plain text without timestamps, so each source is one block.
      const segments: TranscriptSegment[] = [];
      if (system.text) segments.push({ source: "system", text: system.text });
      if (mic?.text) segments.push({ source: "mic", text: mic.text });
      const warning = system.silent ? silenceWarning(windowSeconds) : undefined;
      if (segments.length === 0) {
        return done({ segments, engineUsed: "cloud", warning });
      }
      return done({
        segments,
        transcript: formatTranscriptForLLM(segments, windowSeconds),
        engineUsed: "cloud",
        warning,
      });
    }

    if (!aiAcceptsAudio) {
      return done({
        segments: [],
        engineUsed: "none",
        warning: `Raw audio mode needs an AI provider that accepts audio (such as Gemini). ${NO_AUDIO_PROVIDER} Choose "On this device" transcription instead.`,
      });
    }
    const audioBase64 = await captureRaw();
    const ratio = await silenceRatio(windowSeconds).catch(() => 0);
    return done({
      audioBase64,
      segments: [],
      engineUsed: "raw",
      warning: ratio >= SILENT_RATIO ? silenceWarning(windowSeconds) : undefined,
    });
  } catch (e) {
    return done({
      segments: [],
      engineUsed: "none",
      warning: `Could not read meeting audio: ${errorMessage(e)}`,
    });
  }
}
