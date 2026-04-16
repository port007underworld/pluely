import {
  AI_PROVIDERS,
  DEFAULT_SCREENSHOT_AUTO_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  SPEECH_TO_TEXT_PROVIDERS,
  STORAGE_KEYS,
} from "@/config";
import { getPlatform, safeLocalStorage, trackAppStart } from "@/lib";
import { getShortcutsConfig } from "@/lib/storage";
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
  const [systemPrompt, setSystemPrompt] = useState<string>(
    safeLocalStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) ||
      DEFAULT_SYSTEM_PROMPT
  );

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
  const [hasActiveLicense, setHasActiveLicense] = useState<boolean>(true);
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

  // Runningbord API State
  const [runningbordApiEnabled, setRunningbordApiEnabledState] = useState<boolean>(
    safeLocalStorage.getItem(STORAGE_KEYS.RUNNINGBORD_API_ENABLED) === "true"
  );

  const getActiveLicenseStatus = async () => {
    setHasActiveLicense(true);
    setRunningbordApiEnabled(false);
  };


  useEffect(() => {
    const syncLicenseState = async () => {
      try {
        await invoke("set_license_status", {
          hasLicense: hasActiveLicense,
        });

        const config = getShortcutsConfig();
        await invoke("update_shortcuts", { config });
      } catch (error) {
        console.error("Failed to synchronize license state:", error);
      }
    };

    syncLicenseState();

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
  }, [hasActiveLicense]);

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
            autoPrompt:
              parsed.autoPrompt ||
              DEFAULT_SCREENSHOT_AUTO_PROMPT,
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

    // Load selected AI provider
    const savedSelectedAi = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_AI_PROVIDER
    );
    if (savedSelectedAi) {
      setSelectedAIProvider(JSON.parse(savedSelectedAi));
    }

    // Load selected STT provider
    const savedSelectedStt = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_STT_PROVIDER
    );
    if (savedSelectedStt) {
      setSelectedSttProvider(JSON.parse(savedSelectedStt));
    }

    // Load customizable state
    const customizableState = getCustomizableState();
    setCustomizable(customizableState);

    updateCursor(customizableState.cursor.type || "invisible");

    const stored = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
    if (!stored) {
      // save the default state
      setCustomizableState(customizableState);
    }

    // Load Runningbord API enabled state
    const savedRunningbordApiEnabled = safeLocalStorage.getItem(
      STORAGE_KEYS.RUNNINGBORD_API_ENABLED
    );
    if (savedRunningbordApiEnabled !== null) {
      setRunningbordApiEnabledState(savedRunningbordApiEnabled === "true");
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
    const initializeApp = async () => {
      // Load license and data
      await getActiveLicenseStatus();

      // Track app start
      try {
        const appVersion = await invoke<string>("get_app_version");
        const storage = await invoke<{
          instance_id: string;
        }>("secure_storage_get");
        await trackAppStart(appVersion, storage.instance_id || "");
      } catch (error) {
        console.debug("Failed to track app start:", error);
      }
    };
    // Load data
    loadData();
    initializeApp();
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
    const checkImageSupport = async () => {
      if (runningbordApiEnabled) {
        // For Runningbord API, check the selected model's modality
        try {
          const storage = await invoke<{
            selected_runningbord_model?: string;
          }>("secure_storage_get");

          if (storage.selected_runningbord_model) {
            const model = JSON.parse(storage.selected_runningbord_model);
            const hasImageSupport = model.modality?.includes("image") ?? false;
            setSupportsImages(hasImageSupport);
          } else {
            // No model selected, assume no image support
            setSupportsImages(false);
          }
        } catch (error) {
          setSupportsImages(false);
        }
      } else {
        // For custom AI providers, check if curl contains {{IMAGE}}
        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (provider) {
          const hasImageSupport = provider.curl?.includes("{{IMAGE}}") ?? false;
          setSupportsImages(hasImageSupport);
        } else {
          setSupportsImages(true);
        }
      }
    };

    checkImageSupport();
  }, [runningbordApiEnabled, selectedAIProvider.provider]);

  // Sync selected AI to localStorage
  useEffect(() => {
    if (selectedAIProvider.provider) {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SELECTED_AI_PROVIDER,
        JSON.stringify(selectedAIProvider)
      );
    }
  }, [selectedAIProvider]);

  // Sync selected STT to localStorage
  useEffect(() => {
    if (selectedSttProvider.provider) {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SELECTED_STT_PROVIDER,
        JSON.stringify(selectedSttProvider)
      );
    }
  }, [selectedSttProvider]);

  // Persist system audio daemon config
  useEffect(() => {
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
      JSON.stringify(systemAudioDaemonConfig)
    );
  }, [systemAudioDaemonConfig]);

  // Apply system audio daemon to backend (start/stop)
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
      } catch (e) {
        console.debug("System audio daemon sync failed:", e);
      }
    };
    apply();
  }, [systemAudioDaemonConfig.enabled, systemAudioDaemonConfig.bufferSeconds]);

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
    if (!runningbordApiEnabled) {
      const selectedProvider = allAiProviders.find((p) => p.id === provider);
      if (selectedProvider) {
        const hasImageSupport =
          selectedProvider.curl?.includes("{{IMAGE}}") ?? false;
        setSupportsImages(hasImageSupport);
      } else {
        setSupportsImages(true);
      }
    }

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

  const setRunningbordApiEnabled = async (enabled: boolean) => {
    setRunningbordApiEnabledState(enabled);
    safeLocalStorage.setItem(STORAGE_KEYS.RUNNINGBORD_API_ENABLED, String(enabled));

    if (enabled) {
      try {
        const storage = await invoke<{
          selected_runningbord_model?: string;
        }>("secure_storage_get");

        if (storage.selected_runningbord_model) {
          const model = JSON.parse(storage.selected_runningbord_model);
          const hasImageSupport = model.modality?.includes("image") ?? false;
          setSupportsImages(hasImageSupport);
        } else {
          // No model selected, assume no image support
          setSupportsImages(false);
        }
      } catch (error) {
        console.debug("Failed to check Runningbord model image support:", error);
        setSupportsImages(false);
      }
    } else {
      // Switching to regular provider - check if curl contains {{IMAGE}}
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (provider) {
        const hasImageSupport = provider.curl?.includes("{{IMAGE}}") ?? false;
        setSupportsImages(hasImageSupport);
      } else {
        setSupportsImages(true);
      }
    }

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
    customizable,
    toggleAppIconVisibility,
    toggleAlwaysOnTop,
    loadData,
    runningbordApiEnabled,
    setRunningbordApiEnabled,
    hasActiveLicense,
    setHasActiveLicense,
    getActiveLicenseStatus,
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
