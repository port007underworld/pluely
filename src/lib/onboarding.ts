import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./storage/helper";

const COMPLETED_KEY = "onboarding_completed";

/**
 * First launch: setup hasn't been finished or skipped, and no AI provider is
 * configured (people upgrading from an earlier version already have one).
 */
export function needsOnboarding(): boolean {
  if (safeLocalStorage.getItem(COMPLETED_KEY) === "true") return false;
  try {
    const selected = JSON.parse(safeLocalStorage.getItem(STORAGE_KEYS.SELECTED_AI_PROVIDER) ?? "null");
    return !selected?.provider;
  } catch {
    return true;
  }
}

export function completeOnboarding() {
  safeLocalStorage.setItem(COMPLETED_KEY, "true");
}
