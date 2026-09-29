import { useEffect, useState } from "react";
import { useApp } from "@/contexts";
import {
  extractVariables,
  safeLocalStorage,
  deleteAllConversations,
} from "@/lib";
import { STORAGE_KEYS } from "@/config";

export const useSettings = () => {
  const {
    screenshotConfiguration,
    setScreenshotConfiguration,
    systemAudioDaemonConfig,
    setSystemAudioDaemonConfig,
    allAiProviders,
    allSttProviders,
    selectedAIProvider,
    selectedSttProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
  } = useApp();
  const [variables, setVariables] = useState<{ key: string; value: string }[]>(
    []
  );
  const [sttVariables, setSttVariables] = useState<
    {
      key: string;
      value: string;
    }[]
  >([]);

  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);

  const handleScreenshotModeChange = (value: "auto" | "manual") => {
    const newConfig = { ...screenshotConfiguration, mode: value };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotPromptChange = (value: string) => {
    const newConfig = { ...screenshotConfiguration, autoPrompt: value };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotEnabledChange = (enabled: boolean) => {
    const newConfig = { ...screenshotConfiguration, enabled };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };


  // Compression settings handlers
  const handleScreenshotCompressionEnabledChange = (enabled: boolean) => {
    const newConfig = { ...screenshotConfiguration, compressionEnabled: enabled };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotCompressionQualityChange = (quality: number) => {
    const newConfig = { ...screenshotConfiguration, compressionQuality: quality };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotCompressionMaxDimChange = (maxDim: number) => {
    const newConfig = { ...screenshotConfiguration, compressionMaxDimension: maxDim };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  // Whether to recompress manually attached images when adding files
  const handleScreenshotRecompressAttachmentsChange = (enabled: boolean) => {
    const newConfig = { ...screenshotConfiguration, recompressAttachments: enabled };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleSystemAudioDaemonEnabledChange = (enabled: boolean) => {
    const newConfig = { ...systemAudioDaemonConfig, enabled };
    setSystemAudioDaemonConfig(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleSystemAudioDaemonBufferSecondsChange = (bufferSeconds: number) => {
    const clamped = Math.min(300, Math.max(5, bufferSeconds));
    const newConfig = { ...systemAudioDaemonConfig, bufferSeconds: clamped };
    setSystemAudioDaemonConfig(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  useEffect(() => {
    if (selectedAIProvider.provider) {
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (provider) {
        const variables = extractVariables(provider?.curl);
        setVariables(variables);
      }
    }
  }, [selectedAIProvider.provider]);

  useEffect(() => {
    if (selectedSttProvider.provider) {
      const provider = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );
      if (provider) {
        const variables = extractVariables(provider?.curl);
        setSttVariables(variables);
      }
    }
  }, [selectedSttProvider.provider]);

  const handleDeleteAllChatsConfirm = async () => {
    try {
      await deleteAllConversations();
      setShowDeleteConfirmDialog(false);
    } catch (error) {
      console.error("Failed to delete all conversations:", error);
    }
  };

  return {
    screenshotConfiguration,
    setScreenshotConfiguration,
    systemAudioDaemonConfig,
    setSystemAudioDaemonConfig,
    handleSystemAudioDaemonEnabledChange,
    handleSystemAudioDaemonBufferSecondsChange,
    handleScreenshotModeChange,
    handleScreenshotPromptChange,
    handleScreenshotEnabledChange,
    handleScreenshotCompressionEnabledChange,
    handleScreenshotCompressionQualityChange,
    handleScreenshotCompressionMaxDimChange,
    handleScreenshotRecompressAttachmentsChange,
    allAiProviders,
    allSttProviders,
    selectedAIProvider,
    selectedSttProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
    handleDeleteAllChatsConfirm,
    showDeleteConfirmDialog,
    setShowDeleteConfirmDialog,
    variables,
    sttVariables,
  };
};
