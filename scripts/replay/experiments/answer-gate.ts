import { TYPE_PROVIDER } from "@/types";
import { fetchAIResponse } from "@/lib/functions/ai-response.function";

/**
 * A second opinion before an automatic answer: a small, fast model reads the
 * last few lines of the conversation and decides whether the line the rules
 * flagged is really something the user wants an answer to right now. The
 * rules decide the obvious cases for free; this judges the rest, and rewrites
 * the question so the real request gets a clean, standalone question.
 */

export interface GateLine {
  /** "You" for the user's microphone, otherwise the other person's name or label. */
  who: string;
  text: string;
}

export interface GateDecision {
  answer: boolean;
  /** The question as a standalone sentence (when answer is true). */
  question: string;
  reason: string;
}

const POLICY = `You decide, during a live meeting or interview, whether an AI assistant should draft an answer for the user right now.

You see the last few lines of the conversation. "You" is the user. Everyone else is another participant. The last line from another participant was flagged as a possible question.

Answer yes only if another participant is asking the user something, or asking them to do something, that the user would genuinely benefit from having an answer or approach drafted for at this moment. For example: a technical or factual question, a request to explain, design, estimate or analyse, a follow-up probing their reasoning, or a problem they have just been given to solve.

Answer no when the user wouldn't need help: greetings, small talk and logistics; checking they're following or can hear; confirmations or rhetorical questions where the speaker is thinking aloud, explaining their own reasoning, or giving feedback; questions about the user's own preferences or plans that only they can answer; anything already answered in the lines that follow; and transcription garbage that doesn't make sense.

The transcript comes from speech recognition, so expect missing punctuation, mis-heard words and sentences split across lines; judge the meaning.

Reply with only this JSON, no other text:
{"answer": true or false, "question": "the question rewritten as one clear standalone sentence, or empty", "reason": "at most eight words"}`;

const MAX_LINES = 10;
const MAX_LINE_CHARS = 400;

export function gatePrompt(lines: GateLine[]): string {
  const recent = lines.slice(-MAX_LINES).map((l) => `${l.who}: ${l.text.trim().slice(0, MAX_LINE_CHARS)}`);
  return `Conversation so far (oldest first):\n${recent.join("\n")}\n\nShould the assistant draft an answer now?`;
}

/** The model's reply as a decision, tolerating a code fence or extra text. */
export function parseGateReply(reply: string): GateDecision | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(reply.slice(start, end + 1));
    if (typeof data.answer !== "boolean") return null;
    return {
      answer: data.answer,
      question: typeof data.question === "string" ? data.question.trim() : "",
      reason: typeof data.reason === "string" ? data.reason.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * Ask the user's fast model. Returns null if it fails, is unclear, or takes
 * longer than `timeoutMs`; the caller then goes with the rules' verdict.
 */
export async function checkWithModel({
  provider,
  selectedProvider,
  lines,
  timeoutMs = 2000,
}: {
  provider: TYPE_PROVIDER;
  selectedProvider: { provider: string; variables: Record<string, string> };
  lines: GateLine[];
  timeoutMs?: number;
}): Promise<GateDecision | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The fast model only: this has to be quick and cheap.
  const variables = { ...selectedProvider.variables };
  delete variables.slow_model;
  try {
    let reply = "";
    for await (const chunk of fetchAIResponse({
      provider,
      selectedProvider: { ...selectedProvider, variables },
      systemPrompt: POLICY,
      raw: true,
      userMessage: gatePrompt(lines),
      signal: controller.signal,
    })) {
      reply += chunk;
    }
    return controller.signal.aborted ? null : parseGateReply(reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
