import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "@/config";
import { getPlatform } from "./platform";
import { getRequestLog } from "./request-log";
import { getConversationSettings } from "./storage/conversation.storage";
import { getResponseSettings } from "./storage/response-settings.storage";
import { getTranscriptionConfig } from "./storage/transcription.storage";

/**
 * Remove anything that looks like a secret before text is written to the log
 * or copied into a report: API keys, bearer tokens, key=value secrets and long
 * opaque strings (tokens, base64 images or audio).
 */
export function redact(text: string): string {
  return text
    .replace(/\b(api[_-]?key|token|secret|password|authorization|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',&]+/gi, "$1$2[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|gsk|xai|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted key]")
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "[long data omitted]");
}

let installed = false;

/**
 * Send uncaught errors and console.error/warn to the local log file, so they
 * can be included in a diagnostics report. Nothing is sent anywhere else.
 */
export function installErrorLogging() {
  if (installed) return;
  installed = true;
  let recent: string[] = [];
  const write = (level: "error" | "warn", parts: unknown[]) => {
    const message = redact(
      parts
        .map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : typeof p === "string" ? p : safeJson(p)))
        .join(" ")
    ).slice(0, 2000);
    // Don't flood the log with the same message.
    if (recent.includes(message)) return;
    recent = [...recent.slice(-19), message];
    invoke("log_event", { level, message }).catch(() => {});
  };
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }
  window.addEventListener("error", (e) => write("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => write("error", ["Unhandled rejection:", e.reason]));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const readJson = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};

/**
 * A plain-text report for a bug report: versions and settings (no keys,
 * prompts or conversation text), recent request outcomes, and the end of the
 * log file.
 */
export async function collectDiagnostics(): Promise<string> {
  const version = await invoke<string>("get_app_version").catch(() => "unknown");
  const ai = readJson(STORAGE_KEYS.SELECTED_AI_PROVIDER);
  const stt = readJson(STORAGE_KEYS.SELECTED_STT_PROVIDER);
  const screenshot = readJson(STORAGE_KEYS.SCREENSHOT_CONFIG);
  const meeting = readJson(STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG);
  const transcription = getTranscriptionConfig();
  const response = getResponseSettings();
  const requests = getRequestLog()
    .slice(0, 10)
    .map(
      (r) =>
        `- ${new Date(r.startedAt).toISOString()} ${r.provider} ${r.status}` +
        ` first text ${r.timeToFirstChunkMs ?? "-"} ms, total ${r.totalMs} ms, ~${r.estimatedPromptTokens} tokens` +
        `${r.images ? `, ${r.images} image(s)` : ""}${r.hasTranscript ? ", transcript" : ""}` +
        (r.steps?.length ? `, steps ${r.steps.map((s) => `${s.label} ${s.ms}`).join("/")}` : "") +
        (r.error ? `\n  error: ${redact(r.error)}` : "")
    );
  const log = await invoke<string>("diagnostics_log_tail", { maxBytes: 24_000 }).catch(
    (e) => `(couldn't read the log: ${e})`
  );

  return redact(
    [
      "## Runningbord diagnostics",
      `- Version: ${version}`,
      `- Platform: ${getPlatform()} (${navigator.userAgent})`,
      `- AI provider: ${ai?.provider || "none"}${ai?.variables?.model ? `, model ${ai.variables.model}` : ""}${ai?.variables?.slow_model ? `, slow model ${ai.variables.slow_model}` : ""}`,
      `- Speech-to-text provider: ${stt?.provider || "none"}`,
      `- Transcription: ${JSON.stringify(transcription)}`,
      `- Meeting mode: ${JSON.stringify(meeting)}`,
      `- Screenshot: mode ${screenshot?.mode ?? "?"}, ${screenshot?.enabled === false ? "area" : "full screen"}, compression ${screenshot?.compressionEnabled ?? "?"}`,
      `- Responses: ${JSON.stringify(response)}`,
      `- Conversation: ${JSON.stringify(getConversationSettings())}`,
      "",
      "## Recent requests",
      requests.length ? requests.join("\n") : "(none)",
      "",
      "## Log (most recent)",
      "```",
      log.trim() || "(empty)",
      "```",
    ].join("\n")
  );
}

export const logFilePath = () => invoke<string>("diagnostics_log_path");
