import { useCallback, useEffect, useMemo, useState } from "react";
import { QUICK_ACTIONS } from "@/config";
import { ChatMessage } from "@/types";

export interface PagedAnswer {
  question: string;
  content: string;
}

const MAX_LABEL = 90;

/** A short label for the question behind an answer (stored prompts can carry whole transcripts). */
export function questionLabel(prompt: string): string {
  const auto = prompt.match(/^Another participant just asked: "([\s\S]*?)"\n/);
  if (auto) return `Auto-answer: ${auto[1]}`;
  const action = QUICK_ACTIONS.find((a) => a.prompt === prompt.trim());
  if (action) return action.label;
  const text = prompt
    .replace(/<meeting_transcript[\s\S]*?<\/meeting_transcript>/g, "")
    .trim()
    .split("\n")[0]
    .trim();
  if (!text) return prompt.trim() ? "Screenshot" : "";
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
}

/**
 * Page through this conversation's answers in the overlay. While on the latest
 * page it follows new answers; after paging back it stays put, so a new
 * automatic answer doesn't pull the text you're reading away.
 */
export function useAnswerPager({
  history,
  response,
  input,
  isLoading,
  conversationId,
}: {
  history: ChatMessage[];
  response: string;
  input: string;
  isLoading: boolean;
  conversationId: string | null;
}) {
  const answers = useMemo<PagedAnswer[]>(() => {
    const list: PagedAnswer[] = [];
    let question = "";
    for (const message of history) {
      if (message.role === "user") question = message.content;
      else if (message.role === "assistant") {
        list.push({ question: questionLabel(question), content: message.content });
      }
    }
    // The answer being written (or just finished but not yet saved).
    const last = list[list.length - 1];
    if ((isLoading || response) && (isLoading || last?.content !== response)) {
      list.push({ question: questionLabel(input), content: response });
    }
    return list;
  }, [history, response, input, isLoading]);

  // null = follow the latest answer.
  const [index, setIndex] = useState<number | null>(null);

  useEffect(() => setIndex(null), [conversationId]);

  const latest = answers.length - 1;
  const current = index === null || index >= latest ? latest : index;
  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(latest, next));
      setIndex(clamped >= latest ? null : clamped);
    },
    [latest]
  );
  const previous = useCallback(() => go(current - 1), [go, current]);
  const next = useCallback(() => go(current + 1), [go, current]);
  const toLatest = useCallback(() => setIndex(null), []);

  return {
    total: answers.length,
    position: current,
    /** The answer shown when paged back; null while on the latest. */
    older: current < latest ? answers[current] : null,
    /** Label of the question behind the answer on screen. */
    question: answers[current]?.question ?? "",
    newer: latest - current,
    previous,
    next,
    toLatest,
  };
}
