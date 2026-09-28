import { useCallback, useEffect, useState } from "react";
import {
  createSystemPrompt,
  getAllSystemPrompts,
  updateSystemPrompt,
  deleteSystemPrompt,
} from "@/lib/database";
import type {
  SystemPrompt,
  SystemPromptInput,
  UpdateSystemPromptInput,
} from "@/types";
import { DEFAULT_PRESET_ID, STORAGE_KEYS, PromptPreset } from "@/config";
import {
  clearSelectedPreset,
  getSelectedPresetId,
  safeLocalStorage,
  selectPreset,
} from "@/lib";
import { useApp } from "@/contexts";

export const useSystemPrompts = () => {
  const { setSystemPrompt } = useApp();
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState<number | null>(
    () => {
      const stored = safeLocalStorage.getItem(
        STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID
      );
      return stored ? Number(stored) : null;
    }
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    getSelectedPresetId
  );

  /**
   * Fetch all system prompts from database
   */
  const fetchPrompts = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await getAllSystemPrompts();
      setPrompts(result);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch system prompts";
      setError(errorMessage);
      console.error("Error fetching system prompts:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Create a new system prompt
   */
  const createPrompt = useCallback(
    async (input: SystemPromptInput): Promise<SystemPrompt> => {
      try {
        setError(null);
        const result = await createSystemPrompt(input);
        await fetchPrompts(); // Refresh list
        return result;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to create system prompt";
        setError(errorMessage);
        console.error("Error creating system prompt:", err);
        throw err;
      }
    },
    [fetchPrompts]
  );

  /**
   * Update an existing system prompt
   */
  const updatePrompt = useCallback(
    async (
      id: number,
      input: UpdateSystemPromptInput
    ): Promise<SystemPrompt> => {
      try {
        setError(null);
        const result = await updateSystemPrompt(id, input);
        await fetchPrompts(); // Refresh list
        return result;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to update system prompt";
        setError(errorMessage);
        console.error("Error updating system prompt:", err);
        throw err;
      }
    },
    [fetchPrompts]
  );

  /**
   * Delete a system prompt
   */
  const deletePrompt = useCallback(
    async (id: number): Promise<void> => {
      try {
        setError(null);
        await deleteSystemPrompt(id);
        await fetchPrompts(); // Refresh list
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to delete system prompt";
        setError(errorMessage);
        console.error("Error deleting system prompt:", err);
        throw err;
      }
    },
    [fetchPrompts]
  );

  /**
   * Refresh prompts list
   */
  const refreshPrompts = useCallback(async () => {
    await fetchPrompts();
  }, [fetchPrompts]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Fetch prompts on mount
  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  /**
   * Load selected prompt on mount and when prompts change
   */
  useEffect(() => {
    if (selectedPromptId && prompts.length > 0) {
      const selectedPrompt = prompts.find((p) => p.id === selectedPromptId);
      if (selectedPrompt) {
        setSystemPrompt(selectedPrompt.prompt);
      } else {
        // Selected prompt was deleted: fall back to the default preset.
        setSelectedPromptId(null);
        setSystemPrompt(selectPreset(DEFAULT_PRESET_ID));
        setSelectedPresetId(DEFAULT_PRESET_ID);
      }
    }
  }, [prompts, selectedPromptId, setSystemPrompt]);

  /**
   * Handle selecting a prompt
   */
  const handleSelectPrompt = useCallback(
    (promptId: number) => {
      const selectedPrompt = prompts.find((p) => p.id === promptId);
      if (selectedPrompt) {
        setSystemPrompt(selectedPrompt.prompt);
        setSelectedPromptId(promptId);
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_PROMPT,
          selectedPrompt.prompt
        );
        safeLocalStorage.setItem(
          STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID,
          promptId.toString()
        );
        // Clear any selected Runningbord prompt when user selects their own prompt
        safeLocalStorage.removeItem("selected_runningbord_prompt");
        clearSelectedPreset();
        setSelectedPresetId(null);
      }
    },
    [prompts, setSystemPrompt]
  );

  const handleSelectPreset = useCallback(
    (presetId: string) => {
      setSystemPrompt(selectPreset(presetId));
      setSelectedPresetId(presetId);
      setSelectedPromptId(null);
    },
    [setSystemPrompt]
  );

  /** Copy a built-in preset into the user's own (editable) prompts and select it. */
  const copyPreset = useCallback(
    async (preset: PromptPreset) => {
      const created = await createPrompt({
        name: `${preset.name} (custom)`,
        prompt: preset.prompt,
      });
      setSystemPrompt(created.prompt);
      setSelectedPromptId(created.id);
      safeLocalStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, created.prompt);
      safeLocalStorage.setItem(
        STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID,
        created.id.toString()
      );
      clearSelectedPreset();
      setSelectedPresetId(null);
      return created;
    },
    [createPrompt, setSystemPrompt]
  );

  return {
    prompts,
    isLoading,
    error,
    selectedPromptId,
    createPrompt,
    updatePrompt,
    deletePrompt,
    refreshPrompts,
    clearError,
    handleSelectPrompt,
    selectedPresetId,
    handleSelectPreset,
    copyPreset,
  };
};
