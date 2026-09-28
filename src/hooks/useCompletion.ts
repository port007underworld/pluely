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
  appendMessages,
  getConversationById,
  generateConversationTitle,
  shouldUseRunningbordAPI,
  MESSAGE_ID_OFFSET,
  generateConversationId,
  generateMessageId,
  generateRequestId,
  getResponseSettings,
  safeLocalStorage,
  captureMeetingAudio,
  aiProviderAcceptsAudio,
  buildBudgetedHistory,
  getConversationSettings,
  textToBase64,
  base64ToText,
  ensureScreenRecordingPermission,
  SCREEN_RECORDING_HELP,
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

interface ContextInfo {
  sentMessages: number;
  totalMessages: number;
  estimatedTokens: number;
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
    allSttProviders,
    selectedSttProvider,
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
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [idleResetNotice, setIdleResetNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isProcessingScreenshotRef = useRef(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
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

  // Source of truth for the active conversation. Requests and saves read these
  // refs instead of render-time closures, which could be one turn behind.
  const conversationIdRef = useRef<string | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);

  const setConversation = useCallback(
    (id: string | null, history: ChatMessage[]) => {
      conversationIdRef.current = id;
      historyRef.current = history;
      setState((prev) => ({
        ...prev,
        currentConversationId: id,
        conversationHistory: history,
      }));
    },
    []
  );

  const lastActivityRef = useRef(Date.now());
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Called at the start of every request: returns the history to send, after
  // starting a fresh conversation if the current one has gone idle.
  const buildRequestHistory = useCallback((currentMessage: string) => {
    const { idleResetMinutes, historyBudgetTokens } = getConversationSettings();
    const idleMs = Date.now() - lastActivityRef.current;
    if (
      idleResetMinutes > 0 &&
      conversationIdRef.current !== null &&
      idleMs > idleResetMinutes * 60_000
    ) {
      setConversation(null, []);
      setIdleResetNotice(
        `Started a new conversation after ${Math.round(idleMs / 60_000)} min of inactivity.`
      );
    } else {
      setIdleResetNotice(null);
    }
    lastActivityRef.current = Date.now();

    const built = buildBudgetedHistory(historyRef.current, historyBudgetTokens, currentMessage);
    setContextInfo({
      sentMessages: built.sentMessages,
      totalMessages: built.totalMessages,
      estimatedTokens: built.estimatedTokens,
    });
    return built.messages;
  }, [setConversation]);

  const saveCurrentConversation = useCallback(
    async (
      userMessage: string,
      assistantResponse: string,
      _attachedFiles: AttachedFile[]
    ) => {
      if (!userMessage || !assistantResponse) {
        console.error("Cannot save conversation: missing message content");
        return;
      }

      const isNew = conversationIdRef.current === null;
      const conversationId =
        conversationIdRef.current ?? generateConversationId("chat");
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

      lastActivityRef.current = Date.now();
      // Update memory first so a shortcut pressed while the DB write is still
      // running already sees this turn.
      setConversation(conversationId, [
        ...historyRef.current,
        userMsg,
        assistantMsg,
      ]);

      try {
        await appendMessages(
          {
            id: conversationId,
            title: isNew ? generateConversationTitle(userMessage) : "",
            createdAt: timestamp,
          },
          [userMsg, assistantMsg]
        );
      } catch (error) {
        console.error("Failed to save conversation:", error);
        setState((prev) => ({
          ...prev,
          error: "Failed to save conversation. Please try again.",
        }));
      }
    },
    [setConversation]
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

      const textContext = state.attachedFiles
        .filter((file) => file.type === "text/plain")
        .map((file) => base64ToText(file.base64))
        .join("\n\n");
      const messageForRequest = textContext ? `${input}\n\n${textContext}` : input;

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
        const messageHistory = buildRequestHistory(messageForRequest);

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
            userMessage: messageForRequest,
            imagesBase64: imagesForRequest, // Use frozen constant
            audioBase64: audioForRequest,   // Use frozen constant
            signal,
            requestId,
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
            messageForRequest,
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
      buildRequestHistory,
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

  // Switching conversations cancels any in-flight answer, which would otherwise
  // be saved into the conversation being switched to.
  const loadConversation = useCallback(
    (conversation: ChatConversation) => {
      cancel();
      lastActivityRef.current = Date.now();
      setIdleResetNotice(null);
      setContextInfo(null);
      setConversation(conversation.id, conversation.messages);
      setState((prev) => ({
        ...prev,
        input: "",
        response: "",
        error: null,
        isLoading: false,
      }));
    },
    [cancel, setConversation]
  );

  const startNewConversation = useCallback(() => {
    cancel();
    setIdleResetNotice(null);
    setContextInfo(null);
    setConversation(null, []);
    setState((prev) => ({
      ...prev,
      input: "",
      response: "",
      error: null,
      isLoading: false,
      attachedFiles: [],
    }));
  }, [cancel, setConversation]);



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
          const promptForRequest = audioTranscription?.trim()
            ? `${prompt}\n\n${audioTranscription}`
            : prompt;

          // Cancel any existing request
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }

          abortControllerRef.current = new AbortController();
          const signal = abortControllerRef.current.signal;

          try {
            const messageHistory = buildRequestHistory(promptForRequest);

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

            // Use the fetchAIResponse function with image and signal
            for await (const chunk of fetchAIResponse({
              provider: useRunningbordAPI ? undefined : provider,
              selectedProvider: getEffectiveProvider(),
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage: promptForRequest,
              imagesBase64: [base64],
              audioBase64: audioBase64,
              signal,
              requestId,
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
              await saveCurrentConversation(promptForRequest, fullResponse, filesToSave);
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

          const extraFiles: AttachedFile[] = [];
          if (audioAttachedFile) extraFiles.push(audioAttachedFile);
          if (audioTranscription?.trim()) {
            const transcriptBase64 = textToBase64(audioTranscription);
            extraFiles.push({
              id: Date.now().toString() + "_transcript",
              name: `meeting_transcript_${Date.now()}.txt`,
              type: "text/plain",
              base64: transcriptBase64,
              size: transcriptBase64.length,
            });
          }

          setState((prev) => ({
            ...prev,
            attachedFiles: [...prev.attachedFiles, attachedFile, ...extraFiles],
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
      buildRequestHistory,
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

  const captureShortcutAudio = useCallback(async () => {
    if (!systemAudioDaemonConfig.enabled) {
      setAudioNotice(null);
      return undefined;
    }
    const capture = await captureMeetingAudio({
      windowSeconds: systemAudioDaemonConfig.bufferSeconds,
      sttProvider: allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      ),
      sttSelection: selectedSttProvider,
      aiAcceptsAudio: await aiProviderAcceptsAudio(
        allAiProviders.find((p) => p.id === selectedAIProvider.provider)
      ),
    });
    setAudioNotice(capture.warning ?? null);
    return capture;
  }, [
    systemAudioDaemonConfig.enabled,
    systemAudioDaemonConfig.bufferSeconds,
    allSttProviders,
    selectedSttProvider,
    allAiProviders,
    selectedAIProvider.provider,
  ]);

  const captureScreenshot = useCallback(async () => {
    if (!handleScreenshotSubmit) return;

    const config = screenshotConfigRef.current;
    const triggerStartedAt = performance.now();
    screenshotInitiatedByThisContext.current = true;
    setIsScreenshotLoading(true);

    try {
      if (!(await ensureScreenRecordingPermission())) {
        setState((prev) => ({ ...prev, error: SCREEN_RECORDING_HELP }));
        setIsScreenshotLoading(false);
        screenshotInitiatedByThisContext.current = false;
        return;
      }

      if (config.enabled) {
        const screenshotCaptureStart = performance.now();
        const base64 = await invoke("capture_to_base64", {
          compressionEnabled: config.compressionEnabled ?? true,
          compressionQuality: config.compressionQuality ?? 75,
          compressionMaxDimension: config.compressionMaxDimension ?? 1600,
        });
        const screenshotCaptureMs = performance.now() - screenshotCaptureStart;

        const audio = await captureShortcutAudio();

        if (config.mode === "auto") {
          await handleScreenshotSubmit(
            base64 as string,
            config.autoPrompt,
            audio?.audioBase64,
            audio?.transcript,
            {
              triggerStartedAt,
              triggerSource: "fullscreen",
              screenshotCaptureMs,
              audioFetchMs: audio?.fetchMs,
              customPromptUsed: false,
            }
          );
        } else if (config.mode === "manual") {
          await handleScreenshotSubmit(
            base64 as string,
            undefined,
            audio?.audioBase64,
            audio?.transcript
          );
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
  }, [handleScreenshotSubmit, captureShortcutAudio]);

  const processSelectionRef = useRef<((base64: string) => Promise<void>) | null>(null);
  processSelectionRef.current = async (base64: string) => {
    const config = screenshotConfigRef.current;
    const triggerStartedAt = performance.now();

    try {
      const audio = await captureShortcutAudio();

      if (config.mode === "auto") {
        await handleScreenshotSubmit(
          base64,
          config.autoPrompt,
          audio?.audioBase64,
          audio?.transcript,
          {
            triggerStartedAt,
            triggerSource: "selection",
            audioFetchMs: audio?.fetchMs,
            customPromptUsed: false,
          }
        );
      } else if (config.mode === "manual") {
        await handleScreenshotSubmit(
          base64,
          undefined,
          audio?.audioBase64,
          audio?.transcript
        );
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
  };

  // Subscribe once and dispatch through a ref: re-subscribing per render let an
  // unresolved listen() outlive cleanup and fire with stale conversation state.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<string>("captured-selection", (event) => {
      if (!screenshotInitiatedByThisContext.current) return;
      if (isProcessingScreenshotRef.current) return;
      isProcessingScreenshotRef.current = true;
      void processSelectionRef.current?.(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
    globalShortcuts.registerCustomShortcutCallback("new_conversation", () => {
      startNewConversation();
      setKeepEngaged(false);
    });
    return () => {
      globalShortcuts.unregisterCustomShortcutCallback("toggle_system_audio");
      globalShortcuts.unregisterCustomShortcutCallback("new_conversation");
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
    startNewConversation,
  ]);

  return {
    input: state.input,
    setInput,
    response: state.response,
    setResponse,
    isLoading: state.isLoading,
    audioNotice,
    idleResetNotice,
    contextInfo,
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
