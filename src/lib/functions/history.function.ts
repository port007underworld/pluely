import { Message } from "@/types";

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** When the message was saved (ms). Used to line transcripts up in time. */
  timestamp?: number;
}

export interface BudgetedHistory {
  messages: Message[];
  /** Messages in the stored conversation. */
  totalMessages: number;
  /** Messages actually sent. */
  sentMessages: number;
  estimatedTokens: number;
}

const TRANSCRIPT_BLOCK = /<meeting_transcript[\s\S]*?<\/meeting_transcript>/g;
const TRANSCRIPT_PLACEHOLDER =
  "[Earlier meeting transcript omitted; a newer transcript appears later in this conversation.]";
const COVERED_PLACEHOLDER =
  "[Meeting transcript omitted; the transcript in the latest message covers the same period.]";
const OMITTED_NOTE = "(Earlier messages in this conversation were omitted.)\n\n";
/** A saved message's timestamp is when the answer finished, a little after capture. */
const SAVE_LAG_MARGIN_MS = 30_000;

/** Rough token estimate (~4 characters per token), plus per-message overhead. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4) + 4;

/** Window length of a transcript block (`window="last 5 min"` / `"last 30s"`), in ms. */
function transcriptWindowMs(message: string): number | null {
  const match = message.match(/<meeting_transcript window="last (\d+)(?: (min)|s)"/);
  if (!match) return null;
  return Number(match[1]) * (match[2] ? 60_000 : 1_000);
}

/** Line offset like "[-4m12s]" or "[-9s]" in ms (negative), or null if untimed. */
function lineOffsetMs(line: string): number | null {
  const match = line.match(/^\[-(?:(\d+)m)?(\d+)s\] /);
  if (!match) return null;
  return -((Number(match[1] ?? 0) * 60 + Number(match[2])) * 1000);
}

/**
 * Keep only transcript lines spoken before `coverStart` (older than the current
 * message's window). Returns null when nothing remains.
 */
function trimCoveredLines(block: string, savedAt: number, coverStart: number): string | null {
  const lines = block.split("\n");
  const header = lines.slice(0, 2); // opening tag + legend
  const footer = lines[lines.length - 1];
  const body = lines.slice(2, -1).filter((line) => {
    const offset = lineOffsetMs(line);
    // Untimed (cloud) transcripts can't be aligned: treat as covered.
    if (offset === null) return false;
    return savedAt - SAVE_LAG_MARGIN_MS + offset < coverStart;
  });
  return body.length > 0 ? [...header, ...body, footer].join("\n") : null;
}

/**
 * Pick the past messages to send with a request:
 * - Consecutive transcripts overlap heavily. If the current message carries a
 *   transcript, the newest earlier transcript keeps only lines from before the
 *   current window. Without a current transcript it is kept whole. Any older
 *   transcripts become a one-line placeholder.
 * - Newest messages are kept until the token budget is used (0 = unlimited).
 *   The most recent exchange is always kept, and the kept history always starts
 *   with a user message (some providers require user/assistant alternation).
 */
export function buildBudgetedHistory(
  history: HistoryMessage[],
  budgetTokens: number,
  currentMessage = "",
  now = Date.now()
): BudgetedHistory {
  const currentWindow = transcriptWindowMs(currentMessage);
  const coverStart = currentWindow !== null ? now - currentWindow : null;

  let newestTranscriptSeen = false;
  const deduped = [...history]
    .reverse()
    .map((msg) => {
      if (msg.role !== "user" || !msg.content.includes("<meeting_transcript")) return msg;
      if (newestTranscriptSeen) {
        return { ...msg, content: msg.content.replace(TRANSCRIPT_BLOCK, TRANSCRIPT_PLACEHOLDER) };
      }
      newestTranscriptSeen = true;
      if (coverStart === null) return msg;
      return {
        ...msg,
        content: msg.content.replace(TRANSCRIPT_BLOCK, (block) =>
          msg.timestamp === undefined
            ? COVERED_PLACEHOLDER
            : trimCoveredLines(block, msg.timestamp, coverStart) ?? COVERED_PLACEHOLDER
        ),
      };
    })
    .reverse();

  const kept: HistoryMessage[] = [];
  let tokens = 0;
  for (let i = deduped.length - 1; i >= 0; i--) {
    const cost = estimateTokens(deduped[i].content);
    const mustKeep = kept.length < 2;
    if (budgetTokens > 0 && !mustKeep && tokens + cost > budgetTokens) break;
    kept.unshift(deduped[i]);
    tokens += cost;
  }
  while (kept.length > 0 && kept[0].role !== "user") {
    tokens -= estimateTokens(kept[0].content);
    kept.shift();
  }

  const truncated = kept.length < deduped.length;
  if (truncated && kept.length > 0) {
    kept[0] = { ...kept[0], content: OMITTED_NOTE + kept[0].content };
  }

  return {
    messages: kept.map((m) => ({ role: m.role, content: m.content })) as Message[],
    totalMessages: history.length,
    sentMessages: kept.length,
    estimatedTokens: tokens,
  };
}
