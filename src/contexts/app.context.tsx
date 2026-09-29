import {
  AI_PROVIDERS,
  DEFAULT_SCREENSHOT_AUTO_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  SPEECH_TO_TEXT_PROVIDERS,
  STORAGE_KEYS,
} from "@/config";
import { getPlatform, safeLocalStorage } from "@/lib";
import {
  getShortcutsConfig,
  loadProviderSelection,
  persistProviderSelection,
  resolveScreenshotPrompt,
  resolveSystemPrompt,
  useTranscriptionConfig,
} from "@/lib/storage";
import {
  getCustomizableState,
  setCustomizableState,
  updateAppIconVisibility,
  updateAlwaysOnTop,
  CustomizableState,
  CursorType,
  updateCursorType,
} from "@/lib/storage";
import { IContextType, ScreenshotConfig, SystemAudioDaemonConfig, TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

const validateAndProcessCurlProviders = (
  providersJson: string,
  providerType: "AI" | "STT"
): TYPE_PROVIDER[] => {
  try {
    const parsed = JSON.parse(providersJson);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((p) => {
        try {
          curl2Json(p.curl);
          return true;
        } catch (e) {
          return false;
        }

        return true;
      })
      .map((p) => {
        const provider = { ...p, isCustom: true };
        if (providerType === "STT" && provider.curl) {
          provider.curl = provider.curl.replace(/AUDIO_BASE64/g, "AUDIO");
        }
        return provider;
      });
  } catch (e) {
    console.warn(`Failed to parse custom ${providerType} providers`, e);
    return [];
  }
};

// Create the context
const AppContext = createContext<IContextType | undefined>(undefined);

// Create the provider component
export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [systemPrompt, setSystemPrompt] = useState<string>(resolveSystemPrompt);

  // AI Providers
  const [customAiProviders, setCustomAiProviders] = useState<TYPE_PROVIDER[]>(
    []
  );
  const [selectedAIProvider, setSelectedAIProvider] = useState<{
    provider: string;
    variables: Record<string, string>;
  }>({
    provider: "",
    variables: {},
  });

  // STT Providers
  const [customSttProviders, setCustomSttProviders] = useState<TYPE_PROVIDER[]>(
    []
  );
  const [selectedSttProvider, setSelectedSttProvider] = useState<{
    provider: string;
    variables: Record<string, string>;
  }>({
    provider: "",
    variables: {},
  });

  const [screenshotConfiguration, setScreenshotConfiguration] =
    useState<ScreenshotConfig>({
      mode: "manual",
      autoPrompt: DEFAULT_SCREENSHOT_AUTO_PROMPT,
      enabled: true,
      // sensible defaults for compression
      compressionEnabled: true,
      compressionQuality: 75,
      compressionMaxDimension: 1600,
    });

  const [systemAudioDaemonConfig, setSystemAudioDaemonConfig] =
    useState<SystemAudioDaemonConfig>({
      enabled: false,
      bufferSeconds: 30,
    });

  // Unified Customizable State (initialize from persisted storage)
  const [customizable, setCustomizable] = useState<CustomizableState>(
    getCustomizableState()
  );
  const [supportsImages, setSupportsImagesState] = useState<boolean>(() => {
    const stored = safeLocalStorage.getItem(STORAGE_KEYS.SUPPORTS_IMAGES);
    return stored === null ? true : stored === "true";
  });

  // Track whether macOS screen recording permission has been granted (cached across sessions)
  const [screenRecordingPermissionGranted, setScreenRecordingPermissionGranted] =
    useState<boolean>(() => {
      const stored = safeLocalStorage.getItem(STORAGE_KEYS.SCREEN_RECORDING_GRANTED);
      return stored === "true";
    });

  const setScreenRecordingPermission = (granted: boolean) => {
    setScreenRecordingPermissionGranted(granted);
    safeLocalStorage.setItem(STORAGE_KEYS.SCREEN_RECORDING_GRANTED, String(granted));
  };

  // On startup, check macOS screen recording permission and cache it (avoid repeated prompting)
  useEffect(() => {
    const checkPermission = async () => {
      try {
        const platform = navigator.platform.toLowerCase();
        if (!platform.includes("mac")) return;
        const { checkScreenRecordingPermission } = await import(
          "tauri-plugin-macos-permissions-api"
        );
        const hasPermission = await checkScreenRecordingPermission();
        if (hasPermission) {
          setScreenRecordingPermission(true);
        }
      } catch (err) {
        // ignore failures - plugin may not be available in non-mac builds
        console.debug("Screen recording permission check failed:", err);
      }
    };

    if (!screenRecordingPermissionGranted) {
      checkPermission();
    }
  }, [screenRecordingPermissionGranted]);

  // Wrapper to sync supportsImages to localStorage
  const setSupportsImages = (value: boolean) => {
    setSupportsImagesState(value);
    safeLocalStorage.setItem(STORAGE_KEYS.SUPPORTS_IMAGES, String(value));
  };

  // Model speed toggle state (fast/slow) — session-scoped, defaults to "fast"
  const [modelSpeed, setModelSpeed] = useState<"fast" | "slow">("fast");

  useEffect(() => {
    invoke("update_shortcuts", { config: getShortcutsConfig() }).catch((error) =>
      console.error("Failed to register shortcuts:", error)
    );

    // On startup, apply saved app-icon visibility to native layer (macOS/Windows/Linux)
    const applySavedAppIconVisibility = async () => {
      try {
        const saved = getCustomizableState();
        await invoke("set_app_icon_visibility", {
          visible: saved.appIcon.isVisible,
        });
      } catch (err) {
        console.debug("Failed to apply saved app icon visibility:", err);
      }
    };

    applySavedAppIconVisibility();
  }, []);

  // Function to load AI, STT, system prompt and screenshot config data from storage
  const loadData = () => {
    // Load system prompt
    const savedSystemPrompt = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_PROMPT
    );
    if (savedSystemPrompt) {
      setSystemPrompt(savedSystemPrompt || DEFAULT_SYSTEM_PROMPT);
    }

    // Load screenshot configuration
    const savedScreenshotConfig = safeLocalStorage.getItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG
    );
    if (savedScreenshotConfig) {
      try {
        const parsed = JSON.parse(savedScreenshotConfig);
        if (typeof parsed === "object" && parsed !== null) {
          setScreenshotConfiguration({
            mode: parsed.mode || "manual",
            autoPrompt: resolveScreenshotPrompt(parsed.autoPrompt),
            enabled: parsed.enabled !== undefined ? parsed.enabled : false,
            // Load compression settings with sensible defaults
            compressionEnabled:
              parsed.compressionEnabled !== undefined
                ? parsed.compressionEnabled
                : true,
            compressionQuality:
              parsed.compressionQuality !== undefined
                ? parsed.compressionQuality
                : 75,
            compressionMaxDimension:
              parsed.compressionMaxDimension !== undefined
                ? parsed.compressionMaxDimension
                : 1600,
          });
        }
      } catch (err) {
        console.warn("Failed to parse screenshot config", err);
      }
    }

    // Load system audio daemon configuration
    const savedSystemAudioConfig = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG
    );
    if (savedSystemAudioConfig) {
      try {
        const parsed = JSON.parse(savedSystemAudioConfig);
        if (typeof parsed === "object" && parsed !== null) {
          setSystemAudioDaemonConfig({
            enabled: Boolean(parsed.enabled),
            bufferSeconds:
              typeof parsed.bufferSeconds === "number" &&
              parsed.bufferSeconds >= 5 &&
              parsed.bufferSeconds <= 300
                ? parsed.bufferSeconds
                : 30,
          });
        }
      } catch (err) {
        console.warn("Failed to parse system audio daemon config", err);
      }
    }

    // Ensure we sync persisted "customizable" settings into state
    try {
      const persistedCustomizable = getCustomizableState();
      setCustomizable(persistedCustomizable);
    } catch (err) {
      console.warn("Failed to load customizable state", err);
    }

    // Check macOS screen recording permission once on startup and cache the result
    (async () => {
      try {
        // Only run on macOS
        const platform = getPlatform();
        if (platform === "macos") {
          try {
            const { checkScreenRecordingPermission } = await import(
              "tauri-plugin-macos-permissions-api"
            );
            const granted = await checkScreenRecordingPermission();
            setScreenRecordingPermission(granted);
          } catch (e) {
            // Ignore if plugin is not available or check fails
            console.debug("Screen recording permission check failed:", e);
          }
        }
      } catch (e) {
        console.debug("Failed to check screen recording permission on startup:", e);
      }
    })();

    // Load custom AI providers
    const savedAi = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOM_AI_PROVIDERS);
    let aiList: TYPE_PROVIDER[] = [];
    if (savedAi) {
      aiList = validateAndProcessCurlProviders(savedAi, "AI");
    }
    setCustomAiProviders(aiList);

    // Load custom STT providers
    const savedStt = safeLocalStorage.getItem(
      STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS
    );
    let sttList: TYPE_PROVIDER[] = [];
    if (savedStt) {
      sttList = validateAndProcessCurlProviders(savedStt, "STT");
    }
    setCustomSttProviders(sttList);

    // Selected providers; API keys come from the system keychain.
    loadProviderSelection(STORAGE_KEYS.SELECTED_AI_PROVIDER, "ai").then((selection) => {
      if (selection) setSelectedAIProvider(selection);
    });
    loadProviderSelection(STORAGE_KEYS.SELECTED_STT_PROVIDER, "stt").then((selection) => {
      if (selection) setSelectedSttProvider(selection);
    });

    // Load customizable state
    const customizableState = getCustomizableState();
    setCustomizable(customizableState);

    updateCursor(customizableState.cursor.type || "invisible");

    const stored = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
    if (!stored) {
      // save the default state
      setCustomizableState(customizableState);
    }
  };

  const updateCursor = (type: CursorType | undefined) => {
    try {
      const currentWindow = getCurrentWindow();
      const platform = getPlatform();
      // For Linux, always use default cursor
      if (platform === "linux") {
        document.documentElement.style.setProperty("--cursor-type", "default");
        return;
      }
      const windowLabel = currentWindow.label;

      if (windowLabel === "dashboard") {
        // For dashboard, always use default cursor
        document.documentElement.style.setProperty("--cursor-type", "default");
        return;
      }

      // For overlay windows (main, capture-overlay-*)
      const safeType = type || "invisible";
      const cursorValue = type === "invisible" ? "none" : safeType;
      document.documentElement.style.setProperty("--cursor-type", cursorValue);
    } catch (error) {
      document.documentElement.style.setProperty("--cursor-type", "default");
    }
  };

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  // Handle customizable settings on state changes
  useEffect(() => {
    const applyCustomizableSettings = async () => {
      try {
        await Promise.all([
          invoke("set_app_icon_visibility", {
            visible: customizable.appIcon.isVisible,
          }),
          invoke("set_always_on_top", {
            enabled: customizable.alwaysOnTop.isEnabled,
          }),
        ]);
      } catch (error) {
        console.error("Failed to apply customizable settings:", error);
      }
    };

    applyCustomizableSettings();
  }, [customizable]);

  // Listen for app icon hide/show events when window is toggled
  useEffect(() => {
    const handleAppIconVisibility = async (isVisible: boolean) => {
      try {
        await invoke("set_app_icon_visibility", { visible: isVisible });
      } catch (error) {
        console.error("Failed to set app icon visibility:", error);
      }
    };

    const unlistenHide = listen("handle-app-icon-on-hide", async () => {
      const currentState = getCustomizableState();
      // Only hide app icon if user has set it to hide mode
      if (!currentState.appIcon.isVisible) {
        await handleAppIconVisibility(false);
      }
    });

    const unlistenShow = listen("handle-app-icon-on-show", async () => {
      // Always show app icon when window is shown, regardless of user setting
      await handleAppIconVisibility(true);
    });

    return () => {
      unlistenHide.then((fn) => fn());
      unlistenShow.then((fn) => fn());
    };
  }, []);

  // Listen to storage events for real-time sync (e.g., multi-tab)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      // Sync supportsImages across windows
      if (e.key === STORAGE_KEYS.SUPPORTS_IMAGES && e.newValue !== null) {
        setSupportsImagesState(e.newValue === "true");
      }

      if (
        e.key === STORAGE_KEYS.CUSTOM_AI_PROVIDERS ||
        e.key === STORAGE_KEYS.SELECTED_AI_PROVIDER ||
        e.key === STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS ||
        e.key === STORAGE_KEYS.SELECTED_STT_PROVIDER ||
        e.key === STORAGE_KEYS.SYSTEM_PROMPT ||
        e.key === STORAGE_KEYS.SCREENSHOT_CONFIG ||
        e.key === STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG ||
        e.key === STORAGE_KEYS.CUSTOMIZABLE
      ) {
        loadData();
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Check if the current AI provider/model supports images
  useEffect(() => {
    // Image input needs an {{IMAGE}} slot in the provider's curl.
    const provider = allAiProviders.find((p) => p.id === selectedAIProvider.provider);
    setSupportsImages(provider ? (provider.curl?.includes("{{IMAGE}}") ?? false) : true);
  }, [selectedAIProvider.provider]);

  // Persist selected providers (secrets to the keychain), debounced while typing.
  useEffect(() => {
    if (!selectedAIProvider.provider) return;
    const timer = setTimeout(() => {
      persistProviderSelection(STORAGE_KEYS.SELECTED_AI_PROVIDER, "ai", selectedAIProvider).catch(
        (error) => console.error("Failed to save AI provider settings:", error)
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [selectedAIProvider]);

  useEffect(() => {
    if (!selectedSttProvider.provider) return;
    const timer = setTimeout(() => {
      persistProviderSelection(STORAGE_KEYS.SELECTED_STT_PROVIDER, "stt", selectedSttProvider).catch(
        (error) => console.error("Failed to save speech-to-text provider settings:", error)
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [selectedSttProvider]);

  // Persist system audio daemon config
  useEffect(() => {
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
      JSON.stringify(systemAudioDaemonConfig)
    );
  }, [systemAudioDaemonConfig]);

  // Apply system audio daemon to backend (start/stop)
  const [systemAudioError, setSystemAudioError] = useState<string | null>(null);
  useEffect(() => {
    const apply = async () => {
      try {
        if (systemAudioDaemonConfig.enabled) {
          await invoke("system_audio_start", {
            bufferSeconds: systemAudioDaemonConfig.bufferSeconds,
          });
        } else {
          await invoke("system_audio_stop");
        }
        setSystemAudioError(null);
      } catch (e) {
        console.warn("System audio daemon sync failed:", e);
        setSystemAudioError(String(e));
      }
    };
    apply();
  }, [systemAudioDaemonConfig.enabled, systemAudioDaemonConfig.bufferSeconds]);

  // The mic buffer follows the system audio daemon, when the user opted in.
  const [transcriptionConfig] = useTranscriptionConfig();
  const captureMic =
    systemAudioDaemonConfig.enabled &&
    transcriptionConfig.captureMic &&
    transcriptionConfig.engine !== "raw";
  useEffect(() => {
    const command = captureMic
      ? invoke("mic_audio_start", { bufferSeconds: systemAudioDaemonConfig.bufferSeconds })
      : invoke("mic_audio_stop");
    command.catch((e) => console.warn("Microphone capture sync failed:", e));
  }, [captureMic, systemAudioDaemonConfig.bufferSeconds]);

  // Live background transcription follows the daemon when the local engine is used.
  const liveTranscription =
    systemAudioDaemonConfig.enabled &&
    transcriptionConfig.engine === "local" &&
    transcriptionConfig.live;
  useEffect(() => {
    const command = liveTranscription
      ? invoke("live_transcript_start", {
          modelId: transcriptionConfig.localModel,
          language: transcriptionConfig.language,
          separateSpeakers: transcriptionConfig.separateSpeakers,
        })
      : invoke("live_transcript_stop");
    command.catch((e) => console.warn("Live transcription sync failed:", e));
  }, [
    liveTranscription,
    transcriptionConfig.localModel,
    transcriptionConfig.language,
    transcriptionConfig.separateSpeakers,
  ]);

  // Computed all AI providers
  const allAiProviders: TYPE_PROVIDER[] = [
    ...AI_PROVIDERS,
    ...customAiProviders,
  ];

  // Computed all STT providers
  const allSttProviders: TYPE_PROVIDER[] = [
    ...SPEECH_TO_TEXT_PROVIDERS,
    ...customSttProviders,
  ];

  const onSetSelectedAIProvider = ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => {
    if (provider && !allAiProviders.some((p) => p.id === provider)) {
      console.warn(`Invalid AI provider ID: ${provider}`);
      return;
    }

    // Update supportsImages immediately when provider changes
    const selectedProvider = allAiProviders.find((p) => p.id === provider);
    setSupportsImages(
      selectedProvider ? (selectedProvider.curl?.includes("{{IMAGE}}") ?? false) : true
    );

    setSelectedAIProvider((prev) => ({
      ...prev,
      provider,
      variables,
    }));
  };

  // Setter for selected STT with validation
  const onSetSelectedSttProvider = ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => {
    if (provider && !allSttProviders.some((p) => p.id === provider)) {
      console.warn(`Invalid STT provider ID: ${provider}`);
      return;
    }

    setSelectedSttProvider((prev) => ({ ...prev, provider, variables }));
  };

  // Toggle handlers
  const toggleAppIconVisibility = async (isVisible: boolean) => {
    const previousState = getCustomizableState();
    const newState = updateAppIconVisibility(isVisible);

    // Optimistically update UI so the toggle feels responsive
    setCustomizable(newState);

    try {
      await invoke("set_app_icon_visibility", { visible: isVisible });
      loadData();
    } catch (error) {
      console.error("Failed to toggle app icon visibility:", error);

      // Revert UI and persisted state on failure
      setCustomizable(previousState);
      setCustomizableState(previousState);

      // Notify user so they know to check system settings or restart the app
      try {
        window.alert(
          "Failed to change app icon visibility. Please check system settings and try restarting the app."
        );
      } catch (e) {
        // ignore
      }
    }
  };

  const toggleAlwaysOnTop = async (isEnabled: boolean) => {
    const newState = updateAlwaysOnTop(isEnabled);
    setCustomizable(newState);
    try {
      await invoke("set_always_on_top", { enabled: isEnabled });
      loadData();
    } catch (error) {
      console.error("Failed to toggle always on top:", error);
    }
  };

  const setCursorType = (type: CursorType) => {
    setCustomizable((prev) => ({ ...prev, cursor: { type } }));
    updateCursor(type);
    updateCursorType(type);
    loadData();
  };


  // Create the context value (extend IContextType accordingly)
  const value: IContextType = {
    systemPrompt,
    setSystemPrompt,
    allAiProviders,
    customAiProviders,
    selectedAIProvider,
    onSetSelectedAIProvider,
    allSttProviders,
    customSttProviders,
    selectedSttProvider,
    onSetSelectedSttProvider,
    screenshotConfiguration,
    setScreenshotConfiguration,
    systemAudioDaemonConfig,
    setSystemAudioDaemonConfig,
    systemAudioError,
    customizable,
    toggleAppIconVisibility,
    toggleAlwaysOnTop,
    loadData,
    setCursorType,
    supportsImages,
    setSupportsImages,
    screenRecordingPermissionGranted,
    setScreenRecordingPermission,
    modelSpeed,
    setModelSpeed,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

// Create a hook to access the context
export const useApp = () => {
  const context = useContext(AppContext);

  if (!context) {
    throw new Error("useApp must be used within a AppProvider");
  }

  return context;
};
