import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";

/**
 * Personal context: things about the user (resume, job description, notes)
 * the AI can draw on when relevant. Stored locally; only the text is kept.
 */
export interface PersonalContextItem {
  id: string;
  kind: "note" | "file";
  title: string;
  content: string;
  enabled: boolean;
  addedAt: number;
}

export interface PersonalContext {
  enabled: boolean;
  items: PersonalContextItem[];
}

/** Cap on the text sent with every request (~12k tokens). */
export const PERSONAL_CONTEXT_MAX_CHARS = 48_000;

const EMPTY: PersonalContext = { enabled: true, items: [] };
const CHANGE_EVENT = "personal-context-changed";

export const getPersonalContext = (): PersonalContext => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.PERSONAL_CONTEXT);
    if (!stored) return EMPTY;
    const parsed = JSON.parse(stored);
    return {
      enabled: parsed.enabled !== false,
      items: Array.isArray(parsed.items)
        ? parsed.items.filter(
            (i: PersonalContextItem) =>
              i && typeof i.id === "string" && typeof i.content === "string"
          )
        : [],
    };
  } catch {
    return EMPTY;
  }
};

export const setPersonalContext = (next: PersonalContext): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.PERSONAL_CONTEXT, JSON.stringify(next));
  } catch (error) {
    throw new Error(
      `Couldn't save your context (${error instanceof Error ? error.message : error}). Try removing a large item.`
    );
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const usePersonalContext = () => {
  const [context, setContext] = useState(getPersonalContext);
  useEffect(() => {
    const refresh = () => setContext(getPersonalContext());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.PERSONAL_CONTEXT) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [context, setPersonalContext] as const;
};

/** Items that will actually be sent, in order, within the size cap. */
export function activeContextItems(context: PersonalContext = getPersonalContext()) {
  if (!context.enabled) return { items: [] as PersonalContextItem[], truncated: false, chars: 0 };
  let chars = 0;
  let truncated = false;
  const items: PersonalContextItem[] = [];
  for (const item of context.items) {
    const content = item.content.trim();
    if (!item.enabled || !content) continue;
    const room = PERSONAL_CONTEXT_MAX_CHARS - chars;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const kept = content.length > room ? content.slice(0, room) : content;
    truncated ||= kept.length < content.length;
    items.push({ ...item, content: kept });
    chars += kept.length;
  }
  return { items, truncated, chars };
}

const escapeAttr = (value: string) => value.replace(/"/g, "'").replace(/[<>]/g, "");

/** The block appended to the system prompt, or "" when nothing is active. */
export function buildPersonalContextBlock(): string {
  const { items } = activeContextItems();
  if (items.length === 0) return "";
  return [
    "<user_context>",
    "Background the user provided about themselves and their situation (for example their resume, a job description, or notes). Use it only when it helps with the current question: answering in the user's own voice with their real experience, tailoring examples to their stack, or matching what the role asks for. Don't mention or summarize it unprompted, and never invent experience, employers or numbers that aren't in it.",
    ...items.map(
      (item) =>
        `<item title="${escapeAttr(item.title || (item.kind === "file" ? "Document" : "Note"))}">\n${item.content.trim()}\n</item>`
    ),
    "</user_context>",
  ].join("\n");
}
