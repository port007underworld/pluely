import { useEffect, useState } from "react";

/**
 * Local-only log of recent AI requests, so "why did it answer that?" can be
 * checked against exactly what was sent. Never leaves the machine; holds no
 * API keys; message text is truncated.
 */
export interface RequestLogEntry {
  requestId: string;
  startedAt: number;
  provider: string;
  status: "ok" | "error" | "cancelled";
  error?: string;
  historyMessages: number;
  historyRoles: string;
  estimatedPromptTokens: number;
  images: number;
  imageBytes: number;
  audioBytes: number;
  hasTranscript: boolean;
  /** First line of the user message, for the collapsed row. */
  promptPreview: string;
  /** Full request text (older entries may not have these). */
  prompt?: string;
  systemPrompt?: string;
  history?: { role: string; content: string }[];
  responseChars: number;
  timeToFirstChunkMs?: number;
  totalMs: number;
}

const STORAGE_KEY = "ai_request_log";
const MAX_ENTRIES = 25;
/** Per-field cap so one huge request can't crowd out the rest of the log. */
const MAX_FIELD_CHARS = 40_000;
const CHANGE_EVENT = "ai-request-log-changed";

export const truncateForLog = (text: string) =>
  text.length > MAX_FIELD_CHARS
    ? `${text.slice(0, MAX_FIELD_CHARS)}\n… (truncated; ${text.length} chars in total)`
    : text;

export const firstLine = (text: string) => text.split("\n").find((l) => l.trim()) ?? "";

export function getRequestLog(): RequestLogEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as RequestLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordRequest(entry: RequestLogEntry): void {
  const level = entry.status === "error" ? "warn" : "info";
  const { prompt: _p, systemPrompt: _s, history: _h, ...summary } = entry;
  console[level]("[ai-response][request]", summary);
  // Drop the oldest entries until the log fits in local storage.
  let next = [entry, ...getRequestLog()].slice(0, MAX_ENTRIES);
  while (next.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
      return;
    } catch {
      next = next.slice(0, next.length - 1);
    }
  }
}

export function clearRequestLog(): void {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useRequestLog() {
  const [entries, setEntries] = useState(getRequestLog);
  useEffect(() => {
    const refresh = () => setEntries(getRequestLog());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return entries;
}
