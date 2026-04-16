import { useState, useCallback, useRef, useEffect } from "react";
import { useWindowResize } from "./useWindow";
import { useGlobalShortcuts } from "@/hooks";
import { MAX_FILES, STORAGE_KEYS } from "@/config";
import { useApp } from "@/contexts";
import {
  emitShortcutPipelineMetrics,
  estimateBase64Bytes,
  estimateUtf8Bytes,
  fetchAIResponse,
  saveConversation,
  getConversationById,
  generateConversationTitle,
  shouldUseRunningbordAPI,
  MESSAGE_ID_OFFSET,
  generateConversationId,
  generateMessageId,
  generateRequestId,
  getResponseSettings,
  safeLocalStorage,
} from "@/lib";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Types for completion
interface AttachedFile {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface CompletionState {
  input: string;
  response: string;
  isLoading: boolean;
  error: string | null;
  attachedFiles: AttachedFile[];
  currentConversationId: string | null;
  conversationHistory: ChatMessage[];
}

interface ShortcutRequestContext {
  triggerStartedAt: number;
  triggerSource: "fullscreen" | "selection";
  screenshotCaptureMs?: number;
  audioFetchMs?: number;
  customPromptUsed?: boolean;
}

export const useCompletion = () => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
    screenRecordingPermissionGranted,
    setScreenRecordingPermission,
    systemAudioDaemonConfig,
    setSystemAudioDaemonConfig,
    modelSpeed,
    setModelSpeed,
  } = useApp();

  // Whether a slow model is configured for the current provider
  const hasSlowModel = Boolean(
    selectedAIProvider?.variables?.slow_model?.trim()
  );

  /**
   * Returns the selectedAIProvider with the MODEL variable swapped
   * to slow_model when the toggle is set to "slow" and a slow model exists.
   * The slow_model key itself is removed so it doesn't leak into the request.
   */
  const getEffectiveProvider = useCallback(() => {
    const vars = { ...selectedAIProvider.variables };
    if (modelSpeed === "slow" && vars.slow_model?.trim()) {
      vars.model = vars.slow_model;
    }
    // Remove slow_model from variables so it's not sent as a placeholder
    delete vars.slow_model;
    return { ...selectedAIProvider, variables: vars };
  }, [selectedAIProvider, modelSpeed]);

  // Mark these as used to avoid TS6133 when some flows don't reference them directly
  void screenRecordingPermissionGranted;
  void setScreenRecordingPermission;
  const globalShortcuts = useGlobalShortcuts();

  const [state, setState] = useState<CompletionState>({
    input: "",
    response: "",
    isLoading: false,
    error: null,
    attachedFiles: [],
    currentConversationId: null,
    conversationHistory: [],
  });
  const [messageHistoryOpen, setMessageHistoryOpen] = useState(false);
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);
  const [keepEngaged, setKeepEngaged] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isProcessingScreenshotRef = useRef(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
  const hasCheckedPermissionRef = useRef(false);
  const screenshotInitiatedByThisContext = useRef(false);

  const { resizeWindow } = useWindowResize();

  useEffect(() => {
    screenshotConfigRef.current = screenshotConfiguration;
  }, [screenshotConfiguration]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
  }, []);

  const setResponse = useCallback((value: string) => {
    setState((prev) => ({ ...prev, response: value }));
  }, []);

  const addFile = useCallback(async (file: File) => {
    try {
      let base64: string;
      let type = file.type;
      let name = file.name;

      const shouldRecompress =
        screenshotConfiguration?.recompressAttachments &&
        screenshotConfiguration?.compressionEnabled &&
        file.type.startsWith("image/");

      if (shouldRecompress) {
        try {
          const maxDim = screenshotConfiguration.compressionMaxDimension ?? 1600;
          const quality = screenshotConfiguration.compressionQuality ?? 75;
          // dynamic import to keep bundle small
          const { compressImageFile } = await import("@/lib/utils");
          base64 = await compressImageFile(file, maxDim, quality);
          type = "image/jpeg";
          name = name.replace(/\.[^/.]+$/, "") + ".jpg";
        } catch (e) {
          console.warn("Recompression failed, falling back to original file:", e);
          base64 = await fileToBase64(file);
        }
      } else {
        base64 = await fileToBase64(file);
      }

      const attachedFile: AttachedFile = {
        id: Date.now().toString(),
        name,
        type,
        base64,
        size: base64.length,
      };

      setState((prev) => ({
        ...prev,
        attachedFiles: [...prev.attachedFiles, attachedFile],
      }));
    } catch (error) {
      console.error("Failed to process file:", error);
    }
  }, [screenshotConfiguration]);

  const removeFile = useCallback((fileId: string) => {
    setState((prev) => ({
      ...prev,
      attachedFiles: prev.attachedFiles.filter((f) => f.id !== fileId),
    }));
  }, []);

  const clearFiles = useCallback(() => {
    setState((prev) => ({ ...prev, attachedFiles: [] }));
  }, []);

    const saveCurrentConversation = useCallback(
    async (
      userMessage: string,
      assistantResponse: string,
      _attachedFiles: AttachedFile[]
    ) => {
      // Validate inputs
      if (!userMessage || !assistantResponse) {
        console.error("Cannot save conversation: missing message content");
        return;
      }

      const conversationId =
        state.currentConversationId || generateConversationId("chat");
      const timestamp = Date.now();

      const userMsg: ChatMessage = {
        id: generateMessageId("user", timestamp),
        role: "user",
        content: userMessage,
        timestamp,
      };

      const assistantMsg: ChatMessage = {
        id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
        role: "assistant",
        content: assistantResponse,
        timestamp: timestamp + MESSAGE_ID_OFFSET,
      };

      const newMessages = [...state.conversationHistory, userMsg, assistantMsg];

      // Get existing conversation if updating
      let existingConversation = null;
      if (state.currentConversationId) {
        try {
          existingConversation = await getConversationById(
            state.currentConversationId
          );
        } catch (error) {
          console.error("Failed to get existing conversation:", error);
        }
      }

      const title =
        state.conversationHistory.length === 0
          ? generateConversationTitle(userMessage)
          : existingConversation?.title ||
            generateConversationTitle(userMessage);

      const conversation: ChatConversation = {
        id: conversationId,
        title,
        messages: newMessages,
        createdAt: existingConversation?.createdAt || timestamp,
        updatedAt: timestamp,
      };

      try {
        await saveConversation(conversation);

        setState((prev) => ({
          ...prev,
          currentConversationId: conversationId,
          conversationHistory: newMessages,
        }));
      } catch (error) {
        console.error("Failed to save conversation:", error);
        // Show error to user
        setState((prev) => ({
          ...prev,
          error: "Failed to save conversation. Please try again.",
        }));
      }
    },
    [state.currentConversationId, state.conversationHistory]
  );
  
  const submit = useCallback(
    async (speechText?: string) => {
      const input = speechText || state.input;

      if (!input.trim()) {
        return;
      }

      // 1. EXTRACT MEDIA CONSTANTS IMMEDIATELY
      // This prevents the "empty cURL" issue caused by clearing state mid-flow
      const imagesForRequest = state.attachedFiles
        .filter((file) => file.type.startsWith("image/"))
        .map((file) => file.base64);

      const audioForRequest = state.attachedFiles
        .filter((file) => file.type.startsWith("audio/"))
        .map((file) => file.base64)[0] || ""; // Grab the first audio file

      if (speechText) {
        setState((prev) => ({
          ...prev,
          input: speechText,
        }));
      }

      const requestId = generateRequestId();
      currentRequestIdRef.current = requestId;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        const messageHistory = state.conversationHistory.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        const useRunningbordAPI = await shouldUseRunningbordAPI();
        if (!selectedAIProvider.provider && !useRunningbordAPI) {
          setState((prev) => ({
            ...prev,
            error: "Please select an AI provider in settings",
          }));
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !useRunningbordAPI) {
          setState((prev) => ({
            ...prev,
            error: "Invalid provider selected",
          }));
          return;
        }

        // Set loading state and clear previous response
        setState((prev) => ({
          ...prev,
          isLoading: true,
          error: null,
          response: "",
        }));

        let fullResponse = "";

        try {
          for await (const chunk of fetchAIResponse({
            provider: useRunningbordAPI ? undefined : provider,
            selectedProvider: getEffectiveProvider(),
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage: input,
            imagesBase64: imagesForRequest, // Use frozen constant
            audioBase64: audioForRequest,   // Use frozen constant
            signal,
          })) {
            if (currentRequestIdRef.current !== requestId || signal.aborted) {
              return;
            }

            fullResponse += chunk;
            setState((prev) => ({
              ...prev,
              response: prev.response + chunk,
            }));
          }
        } catch (e: any) {
          if (currentRequestIdRef.current === requestId && !signal.aborted) {
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: e.message || "An error occurred",
            }));
          }
          return;
        }

        if (currentRequestIdRef.current !== requestId || signal.aborted) {
          return;
        }

        setState((prev) => ({ ...prev, isLoading: false }));

        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);

        if (fullResponse) {
          // Pass the captured files to the save function
          await saveCurrentConversation(
            input,
            fullResponse,
            state.attachedFiles
          );
          
          // Clear input and files only AFTER request is complete
          setState((prev) => ({
            ...prev,
            input: "",
            attachedFiles: [],
          }));
        }
      } catch (error) {
        if (!signal?.aborted && currentRequestIdRef.current === requestId) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : "An error occurred",
            isLoading: false,
          }));
        }
      }
    },
    [
      state.input,
      state.attachedFiles, // Added dependency
      state.conversationHistory,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      saveCurrentConversation
    ]
  );

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    currentRequestIdRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  const reset = useCallback(() => {
    // Don't reset if keep engaged mode is active
    if (keepEngaged) {
      return;
    }
    cancel();
    setState((prev) => ({
      ...prev,
      input: "",
      response: "",
      error: null,
      attachedFiles: [],
    }));
  }, [cancel, keepEngaged]);

  // Helper function to convert file to base64
  const fileToBase64 = useCallback(async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string)?.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
    });
  }, []);

  // Note: saveConversation, getConversationById, and generateConversationTitle
  // are now imported from lib/database/chat-history.action.ts

  const loadConversation = useCallback((conversation: ChatConversation) => {
    setState((prev) => ({
      ...prev,
      currentConversationId: conversation.id,
      conversationHistory: conversation.messages,
      input: "",
      response: "",
      error: null,
      isLoading: false,
    }));
  }, []);

  const startNewConversation = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentConversationId: null,
      conversationHistory: [],
      input: "",
      response: "",
      error: null,
      isLoading: false,
      attachedFiles: [],
    }));
  }, []);



  // Listen for conversation events from the main ChatHistory component
  useEffect(() => {
    const handleConversationSelected = async (event: any) => {
      console.log(event, "event");
      // Only the conversation ID is passed through the event
      const { id } = event.detail;
      console.log(id, "id");
      if (!id || typeof id !== "string") {
        console.error("No conversation ID provided");
        setState((prev) => ({
          ...prev,
          error: "Invalid conversation selected",
        }));
        return;
      }
      console.log(id, "id");
      try {
        // Fetch the full conversation from SQLite
        const conversation = await getConversationById(id);

        if (conversation) {
          loadConversation(conversation);
        } else {
          console.error(`Conversation ${id} not found in database`);
          setState((prev) => ({
            ...prev,
            error: "Conversation not found. It may have been deleted.",
          }));
        }
      } catch (error) {
        console.error("Failed to load conversation:", error);
        setState((prev) => ({
          ...prev,
          error: "Failed to load conversation. Please try again.",
        }));
      }
    };

    const handleNewConversation = () => {
      startNewConversation();
    };

    const handleConversationDeleted = (event: any) => {
      const deletedId = event.detail;
      // If the currently active conversation was deleted, start a new one
      if (state.currentConversationId === deletedId) {
        startNewConversation();
      }
    };

    const handleStorageChange = async (e: StorageEvent) => {
      if (e.key === "runningbord-conversation-selected" && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          const { id } = data;
          if (id && typeof id === "string") {
            const conversation = await getConversationById(id);
            if (conversation) {
              loadConversation(conversation);
            }
          }
        } catch (error) {
          console.error("Failed to parse conversation selection:", error);
        }
      }
    };

    window.addEventListener("conversationSelected", handleConversationSelected);
    window.addEventListener("newConversation", handleNewConversation);
    window.addEventListener("conversationDeleted", handleConversationDeleted);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(
        "conversationSelected",
        handleConversationSelected
      );
      window.removeEventListener("newConversation", handleNewConversation);
      window.removeEventListener(
        "conversationDeleted",
        handleConversationDeleted
      );
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [loadConversation, startNewConversation, state.currentConversationId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const MAX_FILES = 6;

    files.forEach((file) => {
      if (
        (file.type.startsWith("image/") || file.type.startsWith("audio/")) &&
        state.attachedFiles.length < MAX_FILES
      ) {
        addFile(file);
      }
    });

    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const handleScreenshotSubmit = useCallback(
    async (
      base64: string,
      prompt?: string,
      audioBase64?: string | undefined,
      audioTranscription?: string | null,
      requestContext?: ShortcutRequestContext
    ) => {
      if (state.attachedFiles.length >= MAX_FILES) {
        setState((prev) => ({
          ...prev,
          error: `You can only upload ${MAX_FILES} files`,
        }));
        return;
      }

      try {
        // Prepare optional audio attachment ahead of branching so both auto and manual flows can include it
        let audioAttachedFile: AttachedFile | undefined = undefined;
        if (audioBase64 && state.attachedFiles.length < MAX_FILES) {
          audioAttachedFile = {
            id: Date.now().toString() + "_audio",
            name: `system_audio_${Date.now()}.ogg`,
            type: "audio/ogg",
            base64: audioBase64,
            size: audioBase64.length,
          };
        }

        if (prompt) {
          // Auto mode: Submit directly to AI with screenshot (and optional audio attachment)
          const attachedFile: AttachedFile = {
            id: Date.now().toString(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          // Generate unique request ID
          const requestId = generateRequestId();
          currentRequestIdRef.current = requestId;
          const requestStartedAt = performance.now();
          let firstChunkAt: number | null = null;
          let promptForRequest = prompt;

          // Cancel any existing request
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }

          abortControllerRef.current = new AbortController();
          const signal = abortControllerRef.current.signal;

          try {
            // Prepare message history for the AI
            const messageHistory = state.conversationHistory.map((msg) => ({
              role: msg.role,
              content: msg.content,
            }));

            let fullResponse = "";

            const useRunningbordAPI = await shouldUseRunningbordAPI();
            // Check if AI provider is configured
            if (!selectedAIProvider.provider && !useRunningbordAPI) {
              setState((prev) => ({
                ...prev,
                error: "Please select an AI provider in settings",
              }));
              return;
            }

            const provider = allAiProviders.find(
              (p) => p.id === selectedAIProvider.provider
            );
            if (!provider && !useRunningbordAPI) {
              setState((prev) => ({
                ...prev,
                error: "Invalid provider selected",
              }));
              return;
            }

            // Clear previous response and set loading state
            setState((prev) => ({
              ...prev,
              input: prompt,
              isLoading: true,
              error: null,
              response: "",
            }));

            // If we have audio transcription from the attached audio, append it to the prompt
            if (audioTranscription && audioTranscription.trim()) {
              promptForRequest = `${prompt}\n\n[Attached audio transcription]: ${audioTranscription}`;
            }

            // Use the fetchAIResponse function with image and signal
            for await (const chunk of fetchAIResponse({
              provider: useRunningbordAPI ? undefined : provider,
              selectedProvider: getEffectiveProvider(),
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage: promptForRequest,
              imagesBase64: [base64],
              audioBase64: audioBase64,
            })) {
              if (firstChunkAt === null && chunk) {
                firstChunkAt = performance.now();
              }

              // Only update if this is still the current request
              if (currentRequestIdRef.current !== requestId || signal.aborted) {
                return; // Request was superseded or cancelled
              }

              fullResponse += chunk;
              setState((prev) => ({
                ...prev,
                response: prev.response + chunk,
              }));
            }

            // Only proceed if this is still the current request
            if (currentRequestIdRef.current !== requestId || signal.aborted) {
              return;
            }

            setState((prev) => ({ ...prev, isLoading: false }));

            // Focus input after screenshot AI response is complete
            setTimeout(() => {
              inputRef.current?.focus();
            }, 100);

            // Save the conversation after successful completion
            if (fullResponse) {
              const filesToSave = audioAttachedFile ? [attachedFile, audioAttachedFile] : [attachedFile];
              await saveCurrentConversation(prompt, fullResponse, filesToSave);
              // Clear input after saving
              setState((prev) => ({
                ...prev,
                input: "",
              }));
            }
          } catch (e: any) {
            // Only show error if this is still the current request and not aborted
            if (currentRequestIdRef.current === requestId && !signal.aborted) {
              setState((prev) => ({
                ...prev,
                error: e.message || "An error occurred",
              }));
            }
          } finally {
            const completedAt = performance.now();
            const imagePayloadBytes = estimateBase64Bytes(base64);
            const audioPayloadBytes = estimateBase64Bytes(audioBase64 || "");
            const textPayloadBytes = estimateUtf8Bytes(promptForRequest || "");
            const totalPayloadBytes =
              imagePayloadBytes + audioPayloadBytes + textPayloadBytes;

            await emitShortcutPipelineMetrics({
              requestId,
              triggerSource: requestContext?.triggerSource ?? "fullscreen",
              customPromptUsed:
                requestContext?.customPromptUsed ??
                prompt.trim() !== screenshotConfigRef.current.autoPrompt.trim(),
              screenshotCaptureMs: requestContext?.screenshotCaptureMs,
              audioFetchMs: requestContext?.audioFetchMs,
              timeToFirstChunkMs:
                firstChunkAt === null ? undefined : firstChunkAt - requestStartedAt,
              requestRoundTripMs: completedAt - requestStartedAt,
              totalPipelineMs:
                completedAt -
                (requestContext?.triggerStartedAt ?? requestStartedAt),
              imagePayloadBytes,
              audioPayloadBytes,
              textPayloadBytes,
              totalPayloadBytes,
              hadAudio: Boolean(audioBase64),
            });

            // Only update loading state if this is still the current request
            if (currentRequestIdRef.current === requestId && !signal.aborted) {
              setState((prev) => ({ ...prev, isLoading: false }));
            }
          }
        } else {
          // Manual mode: Add to attached files
          const attachedFile: AttachedFile = {
            id: Date.now().toString(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          setState((prev) => ({
            ...prev,
            attachedFiles: audioAttachedFile
              ? [...prev.attachedFiles, attachedFile, audioAttachedFile]
              : [...prev.attachedFiles, attachedFile],
          }));
        }
      } catch (error) {
        console.error("Failed to process screenshot:", error);
        setState((prev) => ({
          ...prev,
          error:
            error instanceof Error
              ? error.message
              : "An error occurred processing screenshot",
          isLoading: false,
        }));
      }
    },
    [
      state.attachedFiles.length,
      state.conversationHistory,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      saveCurrentConversation,
      inputRef,
    ]
  );

  const onRemoveAllFiles = () => {
    clearFiles();
    setIsFilesPopoverOpen(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.isLoading && state.input.trim()) {
        submit();
      }
    }
  };

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      // Check if clipboard contains images
      const items = e.clipboardData?.items;
      if (!items) return;

      const hasImages = Array.from(items).some((item) =>
        item.type.startsWith("image/")
      );

      // If we have images, prevent default text pasting and process images
      if (hasImages) {
        e.preventDefault();

        const processedFiles: File[] = [];

        Array.from(items).forEach((item) => {
          if (
            item.type.startsWith("image/") &&
            state.attachedFiles.length + processedFiles.length < MAX_FILES
          ) {
            const file = item.getAsFile();
            if (file) {
              processedFiles.push(file);
            }
          }
        });

        // Process all files
        await Promise.all(processedFiles.map((file) => addFile(file)));
      }
    },
    [state.attachedFiles.length, addFile]
  );

  const isPopoverOpen =
    state.isLoading ||
    state.response !== "" ||
    state.error !== null ||
    keepEngaged;

  useEffect(() => {
    resizeWindow(isPopoverOpen || messageHistoryOpen || isFilesPopoverOpen);
  }, [
    isPopoverOpen,
    messageHistoryOpen,
    resizeWindow,
    isFilesPopoverOpen,
  ]);

  // Auto scroll to bottom when response updates
  useEffect(() => {
    const responseSettings = getResponseSettings();
    if (
      !keepEngaged &&
      state.response &&
      scrollAreaRef.current &&
      responseSettings.autoScroll
    ) {
      const scrollElement = scrollAreaRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollElement) {
        scrollElement.scrollTo({
          top: scrollElement.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [state.response, keepEngaged]);

  // Keyboard arrow key support for scrolling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const activeScrollRef = scrollAreaRef.current || scrollAreaRef.current;
      const scrollElement = activeScrollRef?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen, scrollAreaRef]);

  // Keyboard shortcut for toggling keep engaged mode (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleToggleShortcut = (e: KeyboardEvent) => {
      // Only trigger when popover is open
      if (!isPopoverOpen) return;

      // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setKeepEngaged((prev) => !prev);
        // Focus the input after toggle (with delay to ensure DOM is ready)
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);
      }
    };

    window.addEventListener("keydown", handleToggleShortcut);
    return () => window.removeEventListener("keydown", handleToggleShortcut);
  }, [isPopoverOpen]);

  const captureScreenshot = useCallback(async () => {
    if (!handleScreenshotSubmit) return;

    const config = screenshotConfigRef.current;
    const triggerStartedAt = performance.now();
    screenshotInitiatedByThisContext.current = true;
    setIsScreenshotLoading(true);

    try {
      // Check screen recording permission on macOS
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac") && !hasCheckedPermissionRef.current) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();

        if (!hasPermission) {
          // Request permission
          await requestScreenRecordingPermission();

          // Wait a moment and check again
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const hasPermissionNow = await checkScreenRecordingPermission();

          if (!hasPermissionNow) {
            setState((prev) => ({
              ...prev,
              error:
                "Screen Recording permission required. Please enable it by going to System Settings > Privacy & Security > Screen & System Audio Recording. If you don't see Runningbord in the list, click the '+' button to add it. If it's already listed, make sure it's enabled. Then restart the app.",
            }));
            setIsScreenshotLoading(false);
            screenshotInitiatedByThisContext.current = false;
            return;
          }
        }
        hasCheckedPermissionRef.current = true;
      }

      if (config.enabled) {
        const screenshotCaptureStart = performance.now();
        const base64 = await invoke("capture_to_base64", {
          compressionEnabled: config.compressionEnabled ?? true,
          compressionQuality: config.compressionQuality ?? 75,
          compressionMaxDimension: config.compressionMaxDimension ?? 1600,
        });
        const screenshotCaptureMs = performance.now() - screenshotCaptureStart;

        // Grab system audio if daemon is on
        let audioBase64: string | undefined;
        let audioFetchMs: number | undefined;
        if (systemAudioDaemonConfig.enabled) {
          try {
            const audioFetchStart = performance.now();
            audioBase64 = await invoke<string>("system_audio_get_recent_base64");
            audioFetchMs = performance.now() - audioFetchStart;
          } catch (e) {
            console.warn("Could not get system audio:", e);
          }
        }

        if (config.mode === "auto") {
          // Auto mode: Submit directly to AI with the configured prompt
          await handleScreenshotSubmit(
            base64 as string,
            config.autoPrompt,
            audioBase64,
            undefined,
            {
              triggerStartedAt,
              triggerSource: "fullscreen",
              screenshotCaptureMs,
              audioFetchMs,
              customPromptUsed: false,
            }
          );
        } else if (config.mode === "manual") {
          // Manual mode: Add to attached files without prompt
          await handleScreenshotSubmit(base64 as string, undefined, audioBase64);
        }
        screenshotInitiatedByThisContext.current = false;
      } else {
        // Selection Mode: Open overlay to select an area
        isProcessingScreenshotRef.current = false;
        await invoke("start_screen_capture");
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: "Failed to capture screenshot. Please try again.",
      }));
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    } finally {
      if (config.enabled) {
        setIsScreenshotLoading(false);
      }
    }
  }, [handleScreenshotSubmit, systemAudioDaemonConfig.enabled]);

  useEffect(() => {
    let unlisten: any;

    const setupListener = async () => {
      unlisten = await listen("captured-selection", async (event: any) => {
        if (!screenshotInitiatedByThisContext.current) {
          return;
        }

        if (isProcessingScreenshotRef.current) {
          return;
        }

        isProcessingScreenshotRef.current = true;
        const base64 = event.payload;
        const config = screenshotConfigRef.current;
        const triggerStartedAt = performance.now();

        try {
          // Grab system audio if daemon is on
          let audioBase64: string | undefined;
          let audioFetchMs: number | undefined;
          if (systemAudioDaemonConfig.enabled) {
            try {
              const audioFetchStart = performance.now();
              audioBase64 = await invoke<string>("system_audio_get_recent_base64");
              audioFetchMs = performance.now() - audioFetchStart;
            } catch (e) {
              console.warn("Could not get system audio:", e);
            }
          }

          if (config.mode === "auto") {
            // Auto mode: Submit directly to AI with the configured prompt
            await handleScreenshotSubmit(
              base64 as string,
              config.autoPrompt,
              audioBase64,
              undefined,
              {
                triggerStartedAt,
                triggerSource: "selection",
                audioFetchMs,
                customPromptUsed: false,
              }
            );
          } else if (config.mode === "manual") {
            // Manual mode: Add to attached files without prompt
            await handleScreenshotSubmit(base64 as string, undefined, audioBase64);
          }
        } catch (error) {
          console.error("Error processing selection:", error);
        } finally {
          setIsScreenshotLoading(false);
          screenshotInitiatedByThisContext.current = false;
          setTimeout(() => {
            isProcessingScreenshotRef.current = false;
          }, 100);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleScreenshotSubmit, systemAudioDaemonConfig.enabled]);

  useEffect(() => {    const unlisten = listen("capture-closed", () => {
      setIsScreenshotLoading(false);
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      currentRequestIdRef.current = null;
    };
  }, []);

  // register callbacks for global shortcuts
  useEffect(() => {
    globalShortcuts.registerInputRef(inputRef.current);
    globalShortcuts.registerScreenshotCallback(captureScreenshot);
    globalShortcuts.registerCustomShortcutCallback(
      "toggle_system_audio",
      () => {
        const newEnabled = !systemAudioDaemonConfig.enabled;
        const newConfig = { ...systemAudioDaemonConfig, enabled: newEnabled };
        setSystemAudioDaemonConfig(newConfig);
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
          JSON.stringify(newConfig)
        );
      }
    );
    return () => {
      globalShortcuts.unregisterCustomShortcutCallback("toggle_system_audio");
    };
  }, [
    globalShortcuts.registerInputRef,
    globalShortcuts.registerScreenshotCallback,
    globalShortcuts.registerCustomShortcutCallback,
    globalShortcuts.unregisterCustomShortcutCallback,
    captureScreenshot,
    inputRef,
    setSystemAudioDaemonConfig,
    systemAudioDaemonConfig,
  ]);

  return {
    input: state.input,
    setInput,
    response: state.response,
    setResponse,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles: state.attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    submit,
    cancel,
    reset,
    setState,
    currentConversationId: state.currentConversationId,
    conversationHistory: state.conversationHistory,
    loadConversation,
    startNewConversation,
    messageHistoryOpen,
    setMessageHistoryOpen,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isPopoverOpen,
    scrollAreaRef,
    resizeWindow,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles,
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    keepEngaged,
    setKeepEngaged,
    modelSpeed,
    setModelSpeed,
    hasSlowModel,
  };
};
