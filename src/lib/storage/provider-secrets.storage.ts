import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "./helper";

/**
 * Selected AI / speech-to-text provider settings. Secret variables (API keys,
 * tokens) are kept in the OS credential store; local storage only holds the
 * non-secret variables plus the names of the ones stored as secrets.
 */
export interface ProviderSelection {
  provider: string;
  variables: Record<string, string>;
}

interface StoredSelection extends ProviderSelection {
  secretVariables?: string[];
}

const SECRET_NAME = /key|token|secret|password|credential/i;

export const isSecretVariable = (name: string) => SECRET_NAME.test(name);

const secretId = (kind: "ai" | "stt", provider: string, variable: string) =>
  `${kind}:${provider}:${variable}`;

async function saveSecrets(kind: "ai" | "stt", selection: ProviderSelection): Promise<string[]> {
  const names: string[] = [];
  for (const [name, value] of Object.entries(selection.variables)) {
    if (!isSecretVariable(name)) continue;
    const key = secretId(kind, selection.provider, name);
    if (value) {
      await invoke("secret_set", { key, value });
      names.push(name);
    } else {
      await invoke("secret_delete", { key });
    }
  }
  return names;
}

/** Store a selection: secrets to the credential store first, then the rest locally. */
export async function persistProviderSelection(
  storageKey: string,
  kind: "ai" | "stt",
  selection: ProviderSelection
): Promise<void> {
  const secretVariables = await saveSecrets(kind, selection);
  const variables = Object.fromEntries(
    Object.entries(selection.variables).filter(([name]) => !isSecretVariable(name))
  );
  const stored: StoredSelection = { provider: selection.provider, variables, secretVariables };
  safeLocalStorage.setItem(storageKey, JSON.stringify(stored));
}

/**
 * Read a selection with its secrets filled in. Older installs kept API keys in
 * local storage; those are moved to the credential store and removed.
 */
export async function loadProviderSelection(
  storageKey: string,
  kind: "ai" | "stt"
): Promise<ProviderSelection | null> {
  const raw = safeLocalStorage.getItem(storageKey);
  if (!raw) return null;
  let stored: StoredSelection;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!stored?.provider) return null;
  const variables = { ...(stored.variables ?? {}) };

  const plaintextSecrets = Object.keys(variables).filter(
    (name) => isSecretVariable(name) && variables[name]
  );
  if (plaintextSecrets.length > 0) {
    try {
      await persistProviderSelection(storageKey, kind, { provider: stored.provider, variables });
    } catch (error) {
      // Keep working with the local copy if the credential store is unavailable.
      console.warn("Couldn't move API keys to the system keychain:", error);
    }
    return { provider: stored.provider, variables };
  }

  for (const name of stored.secretVariables ?? []) {
    try {
      const value = await invoke<string | null>("secret_get", {
        key: secretId(kind, stored.provider, name),
      });
      if (value) variables[name] = value;
    } catch (error) {
      console.warn(`Couldn't read ${name} from the system keychain:`, error);
    }
  }
  return { provider: stored.provider, variables };
}
