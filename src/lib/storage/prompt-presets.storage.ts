import {
  DEFAULT_PRESET_ID,
  DEFAULT_SCREENSHOT_AUTO_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SCREENSHOT_PROMPTS,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
  PROMPT_PRESETS,
  PromptPreset,
  STORAGE_KEYS,
} from "@/config";
import { safeLocalStorage } from "./helper";

const RUNNINGBORD_PROMPT_KEY = "selected_runningbord_prompt";

export const getPreset = (id: string | null): PromptPreset | undefined =>
  PROMPT_PRESETS.find((p) => p.id === id);

export const getSelectedPresetId = (): string | null =>
  safeLocalStorage.getItem(STORAGE_KEYS.SELECTED_PROMPT_PRESET);

/** Make a built-in preset the active system prompt. Returns its text. */
export function selectPreset(id: string): string {
  const preset = getPreset(id) ?? getPreset(DEFAULT_PRESET_ID)!;
  safeLocalStorage.setItem(STORAGE_KEYS.SELECTED_PROMPT_PRESET, preset.id);
  safeLocalStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, preset.prompt);
  safeLocalStorage.removeItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID);
  safeLocalStorage.removeItem(RUNNINGBORD_PROMPT_KEY);
  return preset.prompt;
}

/** Called when the user picks one of their own prompts instead. */
export function clearSelectedPreset(): void {
  safeLocalStorage.removeItem(STORAGE_KEYS.SELECTED_PROMPT_PRESET);
}

/**
 * The system prompt to use at startup. A selected preset always uses its
 * current text, so preset improvements reach users who picked it. Installs
 * without a custom prompt (or still on an old built-in default) get the default preset.
 */
export function resolveSystemPrompt(): string {
  const presetId = getSelectedPresetId();
  if (getPreset(presetId)) return selectPreset(presetId!);

  const saved = safeLocalStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT);
  const customChosen =
    safeLocalStorage.getItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID) ||
    safeLocalStorage.getItem(RUNNINGBORD_PROMPT_KEY);
  if (!customChosen && (!saved || LEGACY_DEFAULT_SYSTEM_PROMPTS.includes(saved.trim()))) {
    return selectPreset(DEFAULT_PRESET_ID);
  }
  return saved || DEFAULT_SYSTEM_PROMPT;
}

/** Screenshot prompt still on an old built-in default → the current default. */
export function resolveScreenshotPrompt(saved: string | undefined): string {
  if (!saved || LEGACY_DEFAULT_SCREENSHOT_PROMPTS.includes(saved.trim())) {
    return DEFAULT_SCREENSHOT_AUTO_PROMPT;
  }
  return saved;
}
