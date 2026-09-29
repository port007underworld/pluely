import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";

/** Facts the user pinned for the current meeting ("Budget is $40k"). */
export interface PinnedFact {
  id: string;
  text: string;
  addedAt: number;
}

export const MAX_PINNED_FACTS = 30;
export const MAX_PINNED_FACT_LENGTH = 300;

const CHANGE_EVENT = "pinned-facts-changed";

export const getPinnedFacts = (): PinnedFact[] => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(STORAGE_KEYS.PINNED_FACTS) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((f: PinnedFact) => f && typeof f.id === "string" && typeof f.text === "string")
      : [];
  } catch {
    return [];
  }
};

const save = (facts: PinnedFact[]) => {
  safeLocalStorage.setItem(STORAGE_KEYS.PINNED_FACTS, JSON.stringify(facts));
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

/** Pin a fact. Returns false if it's empty, a duplicate, or the list is full. */
export function pinFact(text: string): boolean {
  const clean = text.trim().replace(/\s+/g, " ").slice(0, MAX_PINNED_FACT_LENGTH);
  const facts = getPinnedFacts();
  if (!clean || facts.length >= MAX_PINNED_FACTS) return false;
  if (facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return false;
  save([...facts, { id: `pin_${Date.now().toString(36)}`, text: clean, addedAt: Date.now() }]);
  return true;
}

export const unpinFact = (id: string) => save(getPinnedFacts().filter((f) => f.id !== id));
export const clearPinnedFacts = () => save([]);

export const usePinnedFacts = () => {
  const [facts, setFacts] = useState(getPinnedFacts);
  useEffect(() => {
    const refresh = () => setFacts(getPinnedFacts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.PINNED_FACTS) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return facts;
};

/** The block added to the system prompt, or "" when nothing is pinned. */
export function buildPinnedFactsBlock(): string {
  const facts = getPinnedFacts();
  if (facts.length === 0) return "";
  return [
    "<pinned_facts>",
    "Facts the user pinned for this meeting. Treat them as true and current, prefer them over anything that contradicts them in the transcript or screenshot, and use them whenever they're relevant. Don't repeat them back unprompted.",
    ...facts.map((f) => `- ${f.text}`),
    "</pinned_facts>",
  ].join("\n");
}
