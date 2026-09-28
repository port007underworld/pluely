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
  promptPreview: string;
  responseChars: number;
  timeToFirstChunkMs?: number;
  totalMs: number;
}

const STORAGE_KEY = "ai_request_log";
const MAX_ENTRIES = 25;
const PREVIEW_CHARS = 600;
const CHANGE_EVENT = "ai-request-log-changed";

export const truncateForLog = (text: string) =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… (${text.length} chars)` : text;

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
  console[level]("[ai-response][request]", entry);
  try {
    const next = [entry, ...getRequestLog()].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Storage full or unavailable: the console line above is still there.
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
