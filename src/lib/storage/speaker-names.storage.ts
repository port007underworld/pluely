import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";

/**
 * Names the user gave to voices in the current meeting ("Speaker 1" → "Priya",
 * or "Them" when voices aren't told apart). Numbering restarts each meeting,
 * so the names are cleared when a new Meeting mode session starts.
 */
export type SpeakerNames = Record<string, string>;

const CHANGE_EVENT = "speaker-names-changed";

export const getSpeakerNames = (): SpeakerNames => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(STORAGE_KEYS.SPEAKER_NAMES) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const save = (names: SpeakerNames) => {
  safeLocalStorage.setItem(STORAGE_KEYS.SPEAKER_NAMES, JSON.stringify(names));
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export function setSpeakerName(label: string, name: string) {
  const names = { ...getSpeakerNames() };
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (clean && clean !== label) names[label] = clean;
  else delete names[label];
  save(names);
}

export const clearSpeakerNames = () => save({});

/** The name to show for a speaker label ("You", "Them", "Speaker 2"…). */
export const speakerDisplayName = (label: string, names: SpeakerNames = getSpeakerNames()) =>
  names[label] ?? label;

/** One line for transcripts sent to the AI, e.g. `Priya = "Speaker 1"`. */
export function speakerNamesLegend(names: SpeakerNames = getSpeakerNames()): string {
  const entries = Object.entries(names);
  if (entries.length === 0) return "";
  return `The user named some participants: ${entries
    .map(([label, name]) => `${name} (was "${label}")`)
    .join(", ")}.`;
}

export const useSpeakerNames = () => {
  const [names, setNames] = useState(getSpeakerNames);
  useEffect(() => {
    const refresh = () => setNames(getSpeakerNames());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.SPEAKER_NAMES) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return names;
};
