import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";

export interface ConversationSettings {
  /** Start a fresh overlay conversation after this much inactivity. 0 = never. */
  idleResetMinutes: number;
  /** Approximate token budget for past messages sent with each request. 0 = unlimited. */
  historyBudgetTokens: number;
}

export const IDLE_RESET_OPTIONS = [0, 5, 10, 15, 30, 60];
export const HISTORY_BUDGET_OPTIONS = [2000, 4000, 8000, 16000, 32000, 0];

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  idleResetMinutes: 10,
  historyBudgetTokens: 8000,
};

const CHANGE_EVENT = "conversation-settings-changed";

export const getConversationSettings = (): ConversationSettings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CONVERSATION_SETTINGS);
    if (!stored) return DEFAULT_CONVERSATION_SETTINGS;
    const parsed = JSON.parse(stored);
    return {
      idleResetMinutes: IDLE_RESET_OPTIONS.includes(parsed.idleResetMinutes)
        ? parsed.idleResetMinutes
        : DEFAULT_CONVERSATION_SETTINGS.idleResetMinutes,
      historyBudgetTokens: HISTORY_BUDGET_OPTIONS.includes(parsed.historyBudgetTokens)
        ? parsed.historyBudgetTokens
        : DEFAULT_CONVERSATION_SETTINGS.historyBudgetTokens,
    };
  } catch {
    return DEFAULT_CONVERSATION_SETTINGS;
  }
};

export const setConversationSettings = (
  update: Partial<ConversationSettings>
): ConversationSettings => {
  const next = { ...getConversationSettings(), ...update };
  try {
    localStorage.setItem(STORAGE_KEYS.CONVERSATION_SETTINGS, JSON.stringify(next));
  } catch (error) {
    console.error("Failed to save conversation settings:", error);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
};

export const useConversationSettings = () => {
  const [settings, setSettings] = useState(getConversationSettings);

  useEffect(() => {
    const refresh = () => setSettings(getConversationSettings());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.CONVERSATION_SETTINGS) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return [settings, setConversationSettings] as const;
};
