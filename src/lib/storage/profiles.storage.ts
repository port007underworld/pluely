import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";
import { getPersonalContext, setPersonalContext } from "./personal-context.storage";
import { clearSelectedPreset, getPreset, getSelectedPresetId, selectPreset } from "./prompt-presets.storage";
import { getResponseSettings, ResponseSettings, setResponseSettings } from "./response-settings.storage";
import type { ProviderSelection } from "./provider-secrets.storage";

/**
 * A named set of settings for a kind of meeting. Switching profiles saves the
 * current settings into the active profile and applies the new one, so changes
 * made while a profile is active stay with it.
 */
export interface Profile {
  id: string;
  name: string;
  /** Built-in preset, the user's own prompt (by id), or just the text. */
  systemPrompt: { presetId?: string; promptId?: number; text: string };
  contextEnabled: boolean;
  /** Personal context items that are turned on. */
  contextItemIds: string[];
  /** Fast and slow model for the current AI provider; empty = leave as is. */
  model?: string;
  slowModel?: string;
  responseSettings: ResponseSettings;
}

interface ProfilesState {
  activeId: string | null;
  profiles: Profile[];
}

const CHANGE_EVENT = "profiles-changed";
const EMPTY: ProfilesState = { activeId: null, profiles: [] };

export const getProfiles = (): ProfilesState => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(STORAGE_KEYS.PROFILES) ?? "null");
    if (!parsed || !Array.isArray(parsed.profiles)) return EMPTY;
    const profiles = parsed.profiles.filter((p: Profile) => p && typeof p.id === "string");
    const activeId = profiles.some((p: Profile) => p.id === parsed.activeId) ? parsed.activeId : null;
    return { activeId, profiles };
  } catch {
    return EMPTY;
  }
};

const saveProfiles = (state: ProfilesState) => {
  safeLocalStorage.setItem(STORAGE_KEYS.PROFILES, JSON.stringify(state));
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

/** The current settings, as a profile. */
export function captureSettings(
  base: Pick<Profile, "id" | "name">,
  ai: ProviderSelection
): Profile {
  const presetId = getSelectedPresetId();
  const promptId = Number(safeLocalStorage.getItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID)) || undefined;
  const context = getPersonalContext();
  return {
    ...base,
    systemPrompt: {
      presetId: getPreset(presetId) ? presetId! : undefined,
      promptId: getPreset(presetId) ? undefined : promptId,
      text: safeLocalStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) ?? "",
    },
    contextEnabled: context.enabled,
    contextItemIds: context.items.filter((i) => i.enabled).map((i) => i.id),
    model: ai.variables.model || undefined,
    slowModel: ai.variables.slow_model || undefined,
    responseSettings: getResponseSettings(),
  };
}

/**
 * Write a profile's settings to where each one lives. Returns the system prompt
 * and provider selection so the caller can update in-memory state; other
 * windows pick the changes up from storage events.
 */
export function applySettings(
  profile: Profile,
  ai: ProviderSelection
): { systemPrompt: string; ai: ProviderSelection } {
  let systemPrompt = profile.systemPrompt.text;
  if (profile.systemPrompt.presetId && getPreset(profile.systemPrompt.presetId)) {
    systemPrompt = selectPreset(profile.systemPrompt.presetId);
  } else if (systemPrompt) {
    safeLocalStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, systemPrompt);
    if (profile.systemPrompt.promptId) {
      safeLocalStorage.setItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID, String(profile.systemPrompt.promptId));
    } else {
      safeLocalStorage.removeItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID);
    }
    clearSelectedPreset();
  }

  const context = getPersonalContext();
  const ids = new Set(profile.contextItemIds);
  setPersonalContext({
    enabled: profile.contextEnabled,
    items: context.items.map((item) => ({ ...item, enabled: ids.has(item.id) })),
  });

  setResponseSettings(profile.responseSettings);

  let nextAi = ai;
  if (ai.provider && (profile.model || profile.slowModel)) {
    const variables = { ...ai.variables };
    if (profile.model) variables.model = profile.model;
    if (profile.slowModel !== undefined) variables.slow_model = profile.slowModel ?? "";
    nextAi = { ...ai, variables };
  }
  return { systemPrompt, ai: nextAi };
}

const newId = () => `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * Save the current settings as a new profile and make it active, optionally
 * starting from a built-in prompt preset.
 */
export function createProfile(name: string, ai: ProviderSelection, presetId?: string) {
  const state = getProfiles();
  const saved = storeActive(state, ai);
  const profile = captureSettings({ id: newId(), name: name.trim() || "Untitled" }, ai);
  const preset = getPreset(presetId ?? null);
  if (preset) profile.systemPrompt = { presetId: preset.id, text: preset.prompt };
  const applied = applySettings(profile, ai);
  saveProfiles({ activeId: profile.id, profiles: [...saved, profile] });
  return applied;
}

/** Profiles with the current settings stored into the active one. */
function storeActive(state: ProfilesState, ai: ProviderSelection): Profile[] {
  return state.profiles.map((p) =>
    p.id === state.activeId ? captureSettings({ id: p.id, name: p.name }, ai) : p
  );
}

/** Save current settings into the active profile, then apply `id`. */
export function switchProfile(id: string, ai: ProviderSelection) {
  const state = getProfiles();
  const target = state.profiles.find((p) => p.id === id);
  if (!target) throw new Error("That profile no longer exists.");
  const profiles = storeActive(state, ai);
  const applied = applySettings(target, ai);
  saveProfiles({ activeId: id, profiles });
  return applied;
}

export function renameProfile(id: string, name: string) {
  const state = getProfiles();
  saveProfiles({
    ...state,
    profiles: state.profiles.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
  });
}

export function deleteProfile(id: string) {
  const state = getProfiles();
  saveProfiles({
    activeId: state.activeId === id ? null : state.activeId,
    profiles: state.profiles.filter((p) => p.id !== id),
  });
}

export const useProfiles = () => {
  const [state, setState] = useState(getProfiles);
  useEffect(() => {
    const refresh = () => setState(getProfiles());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.PROFILES) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return state;
};
