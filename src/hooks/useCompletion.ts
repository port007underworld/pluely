import { useState, useCallback, useRef, useEffect } from "react";
import { useWindowResize } from "./useWindow";
import { useGlobalShortcuts } from "@/hooks";
import { MAX_FILES, STORAGE_KEYS, autoAnswerPrompt, QUICK_ACTIONS } from "@/config";
import { useApp } from "@/contexts";
import type { AttachedFile } from "@/types";
import {
  fetchAIResponse,
  appendMessages,
  getConversationById,
  generateConversationTitle,
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
  fileToAttachment,
  attachableFiles,
  pastedImages,
  captureFullScreen,
  createQuestionDetector,
  pinFact,
  clearPinnedFacts,
  splitFollowUps,
  FOLLOW_UP_INSTRUCTIONS,
  lastCodeBlock,
  useTranscriptionConfig,
  getTranscriptionConfig,
  setTranscriptionConfig,
  resolveAIProvider,
} from "@/lib";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

// Types for completion

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

  /** The system prompt for overlay answers, asking for follow-up questions when enabled. */
  const overlaySystemPrompt = useCallback(
    (withFollowUps = true) => {
      const base = systemPrompt || "";
      if (!withFollowUps || !getResponseSettings().suggestFollowUps) return base || undefined;
      return base ? `${base}\n\n${FOLLOW_UP_INSTRUCTIONS}` : FOLLOW_UP_INSTRUCTIONS;
    },
    [systemPrompt]
  );

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
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);
  const [keepEngaged, setKeepEngaged] = useState(false);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [idleResetNotice, setIdleResetNotice] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
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

  const addFile = useCallback(
    async (file: File) => {
      try {
        const attachedFile = await fileToAttachment(file, screenshotConfiguration);
        setState((prev) => ({ ...prev, attachedFiles: [...prev.attachedFiles, attachedFile] }));
      } catch (error) {
        console.error("Failed to process file:", error);
      }
    },
    [screenshotConfiguration]
  );

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
      // Follow-up suggestions are for display only; keep them out of history.
      assistantResponse = splitFollowUps(assistantResponse).answer;

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

      // "/pin <fact>" remembers a fact for the rest of the meeting.
      if (/^\/unpin\s+all\s*$/i.test(input.trim()) && !speechText) {
        clearPinnedFacts();
        setState((prev) => ({ ...prev, input: "" }));
        setPinNotice("Cleared all pinned facts.");
        setTimeout(() => setPinNotice(null), 3000);
        return;
      }
      const pin = input.trim().match(/^\/pin\s+([\s\S]+)/i);
      if (pin && !speechText) {
        const added = pinFact(pin[1]);
        setState((prev) => ({ ...prev, input: "" }));
        setPinNotice(added ? `Pinned: ${pin[1].trim()}` : "Already pinned, or the list is full.");
        setTimeout(() => setPinNotice(null), 3000);
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
        const resolved = resolveAIProvider(selectedAIProvider, allAiProviders);
        if ("error" in resolved) {
          setState((prev) => ({ ...prev, error: resolved.error }));
          return;
        }
        const { provider } = resolved;

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
            provider,
            selectedProvider: getEffectiveProvider(),
            systemPrompt: overlaySystemPrompt(),
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
      overlaySystemPrompt,
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

  /** Close the answer panel. `force` also closes it in conversation mode. */
  const reset = useCallback((force = false) => {
    if (keepEngaged && !force) {
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
    attachableFiles(Array.from(e.target.files || []), state.attachedFiles.length).forEach(addFile);
    // Reset input so the same file can be selected again
    e.target.value = "";
  };

  /**
   * Send a request straight to the AI (no editing in the input box), stream the
   * answer into the panel and save the turn. Used by auto-mode screenshots and
   * automatic question answering.
   */
  const sendDirect = useCallback(
    async ({
      displayPrompt,
      userMessage,
      imagesBase64,
      audioBase64,
      files,
      followUps = true,
      steps,
    }: {
      displayPrompt: string;
      userMessage: string;
      imagesBase64?: string[];
      audioBase64?: string;
      files: AttachedFile[];
      /** Ask for follow-up questions (off for requests that are themselves questions). */
      followUps?: boolean;
      /** Timings of the steps that led to this request, for Recent Requests. */
      steps?: { label: string; ms: number }[];
    }) => {
      const resolved = resolveAIProvider(selectedAIProvider, allAiProviders);
      if ("error" in resolved) {
        setState((prev) => ({ ...prev, error: resolved.error }));
        return;
      }
      const { provider } = resolved;

      const requestId = generateRequestId();
      currentRequestIdRef.current = requestId;
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        const messageHistory = buildRequestHistory(userMessage);
        let fullResponse = "";

        setState((prev) => ({
          ...prev,
          input: displayPrompt,
          isLoading: true,
          error: null,
          response: "",
        }));

        for await (const chunk of fetchAIResponse({
          provider,
          selectedProvider: getEffectiveProvider(),
          systemPrompt: overlaySystemPrompt(followUps),
          history: messageHistory,
          userMessage,
          imagesBase64,
          audioBase64,
          signal,
          requestId,
          steps,
        })) {
          if (currentRequestIdRef.current !== requestId || signal.aborted) return;
          fullResponse += chunk;
          setState((prev) => ({ ...prev, response: prev.response + chunk }));
        }

        if (currentRequestIdRef.current !== requestId || signal.aborted) return;
        setState((prev) => ({ ...prev, isLoading: false }));
        setTimeout(() => inputRef.current?.focus(), 100);

        if (fullResponse) {
          await saveCurrentConversation(userMessage, fullResponse, files);
          setState((prev) => ({ ...prev, input: "" }));
        }
      } catch (e: any) {
        if (currentRequestIdRef.current === requestId && !signal.aborted) {
          setState((prev) => ({ ...prev, error: e.message || "An error occurred" }));
        }
      } finally {
        if (currentRequestIdRef.current === requestId && !signal.aborted) {
          setState((prev) => ({ ...prev, isLoading: false }));
        }
      }
    },
    [
      selectedAIProvider,
      allAiProviders,
      buildRequestHistory,
      getEffectiveProvider,
      overlaySystemPrompt,
      saveCurrentConversation,
      inputRef,
    ]
  );

  const handleScreenshotSubmit = useCallback(
    async (
      base64: string,
      prompt?: string,
      audioBase64?: string | undefined,
      audioTranscription?: string | null
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

          await sendDirect({
            displayPrompt: prompt,
            userMessage: audioTranscription?.trim()
              ? `${prompt}\n\n${audioTranscription}`
              : prompt,
            imagesBase64: [base64],
            audioBase64,
            files: audioAttachedFile ? [attachedFile, audioAttachedFile] : [attachedFile],
          });
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
    [state.attachedFiles.length, sendDirect]
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
      const images = pastedImages(e, state.attachedFiles.length);
      if (images) await Promise.all(images.map(addFile));
    },
    [state.attachedFiles.length, addFile]
  );

  const isPopoverOpen =
    state.isLoading ||
    state.response !== "" ||
    state.error !== null ||
    keepEngaged;

  useEffect(() => {
    resizeWindow(isPopoverOpen || isFilesPopoverOpen);
  }, [isPopoverOpen, resizeWindow, isFilesPopoverOpen]);

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

  const captureShortcutAudio = useCallback(async ({ finishedLinesOnly = false } = {}) => {
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
      finishedLinesOnly,
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
        const base64 = await captureFullScreen(config);

        const audio = await captureShortcutAudio();

        if (config.mode === "auto") {
          await handleScreenshotSubmit(
            base64 as string,
            config.autoPrompt,
            audio?.audioBase64,
            audio?.transcript
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

  // Automatic answers: when another participant asks a question in the live
  // transcript, answer it as if the user had pressed the screenshot shortcut.
  const [transcriptionConfig] = useTranscriptionConfig();
  const autoAnswerEnabled =
    transcriptionConfig.autoAnswer &&
    transcriptionConfig.engine === "local" &&
    transcriptionConfig.live &&
    systemAudioDaemonConfig.enabled;
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  // A question asked while an answer is still being written waits for it; only
  // the newest one is kept, since a follow-up usually supersedes the one before.
  const queuedQuestionRef = useRef<string | null>(null);
  const autoAnsweringRef = useRef(false);

  const queuedEndedAtRef = useRef(0);
  const autoAnswerRef = useRef<(question: string, endedAt: number) => Promise<void>>(async () => {});
  autoAnswerRef.current = async (question: string, endedAt: number) => {
    const current = latestStateRef.current;
    // Don't overwrite something the user is typing.
    if (current.input.trim() && !current.isLoading) return;
    if (current.isLoading || isScreenshotLoading || autoAnsweringRef.current) {
      queuedQuestionRef.current = question;
      queuedEndedAtRef.current = endedAt;
      return;
    }
    autoAnsweringRef.current = true;
    try {
      await answerQuestion(question, endedAt);
    } finally {
      autoAnsweringRef.current = false;
    }
    const next = queuedQuestionRef.current;
    queuedQuestionRef.current = null;
    if (next) void autoAnswerRef.current(next, queuedEndedAtRef.current);
  };

  const answerQuestion = async (question: string, endedAt: number) => {
    const displayPrompt = `Auto-answer: ${question}`;
    const detectedAt = Date.now();
    // Open the panel right away; the transcript and screenshot load meanwhile.
    setState((prev) => ({ ...prev, input: displayPrompt, isLoading: true, error: null, response: "" }));

    const timed = async <T,>(work: Promise<T>) => {
      const started = performance.now();
      const value = await work;
      return { value, ms: Math.round(performance.now() - started) };
    };
    const wantScreenshot = transcriptionConfig.autoAnswerScreenshot;
    let audio: Awaited<ReturnType<typeof captureShortcutAudio>>;
    let screenshot: { value: string | undefined; ms: number } | undefined;
    let transcriptMs = 0;
    try {
      // The question is already transcribed, so don't wait on speech still in progress.
      const [audioResult, screenshotResult] = await Promise.all([
        timed(captureShortcutAudio({ finishedLinesOnly: true })),
        wantScreenshot
          ? timed(
              (async () => {
                if (!(await ensureScreenRecordingPermission())) return undefined;
                return captureFullScreen(screenshotConfigRef.current).catch((error) => {
                  console.warn("Auto-answer screenshot failed:", error);
                  return undefined;
                });
              })()
            )
          : undefined,
      ]);
      audio = audioResult.value;
      transcriptMs = audioResult.ms;
      screenshot = screenshotResult;
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }

    const image = screenshot?.value;
    const prompt = autoAnswerPrompt(question);
    const files: AttachedFile[] = image
      ? [
          {
            id: `${Date.now()}`,
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: image,
            size: image.length,
          },
        ]
      : [];
    const steps = [
      { label: "detected", ms: Math.max(0, detectedAt - endedAt) },
      { label: "transcript", ms: transcriptMs },
      ...(screenshot ? [{ label: "screenshot (parallel)", ms: screenshot.ms }] : []),
      { label: "prepared", ms: Math.max(0, Date.now() - detectedAt - transcriptMs) },
    ];
    return sendDirect({
      displayPrompt,
      userMessage: audio?.transcript?.trim() ? `${prompt}\n\n${audio.transcript}` : prompt,
      imagesBase64: image ? [image] : undefined,
      audioBase64: audio?.audioBase64,
      files,
      steps,
    });
  };

  useEffect(() => {
    if (state.isLoading || autoAnsweringRef.current || !queuedQuestionRef.current) return;
    const next = queuedQuestionRef.current;
    queuedQuestionRef.current = null;
    void autoAnswerRef.current(next, queuedEndedAtRef.current);
  }, [state.isLoading]);

  useEffect(() => {
    if (!autoAnswerEnabled) return;
    const detector = createQuestionDetector({
      onQuestion: (question, endedAt) => void autoAnswerRef.current(question, endedAt),
      pauseMs: transcriptionConfig.autoAnswerDelayMs,
    });
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = <T,>(event: string, handler: (payload: T) => void) =>
      listen<T>(event, ({ payload }) => handler(payload)).then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    // Only the other participants' audio: the user's own questions aren't answered.
    subscribe<{ source: string; text: string; endMs: number }>("live-transcript-segment", (segment) => {
      if (segment.source === "system") detector.line(segment.text, segment.endMs);
    });
    subscribe<{ source: string }>("live-transcript-partial", (partial) => {
      if (partial.source === "system") detector.speaking();
    });
    return () => {
      cancelled = true;
      queuedQuestionRef.current = null;
      detector.dispose();
      unlisteners.forEach((fn) => fn());
    };
  }, [autoAnswerEnabled, transcriptionConfig.autoAnswerDelayMs]);

  // Quick actions rework the last answer; the conversation history carries it.
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const flashNotice = useCallback((text: string) => {
    setActionNotice(text);
    setTimeout(() => setActionNotice((current) => (current === text ? null : current)), 2500);
  }, []);

  const runQuickAction = useCallback(
    (id: string) => {
      const action = QUICK_ACTIONS.find((a) => a.id === id);
      const current = latestStateRef.current;
      if (!action || current.isLoading || historyRef.current.length === 0) return;
      void sendDirect({
        displayPrompt: action.label,
        userMessage: action.prompt,
        files: [],
        followUps: action.id !== "ask_next",
      });
    },
    [sendDirect]
  );

  /** Ask one of the suggested follow-up questions. */
  const askFollowUp = useCallback(
    (question: string) => {
      if (latestStateRef.current.isLoading) return;
      void sendDirect({ displayPrompt: question, userMessage: question, files: [] });
    },
    [sendDirect]
  );

  const copyLastCode = useCallback(async () => {
    const current = latestStateRef.current;
    const lastAnswer =
      current.response ||
      [...historyRef.current].reverse().find((m) => m.role === "assistant")?.content ||
      "";
    const code = lastCodeBlock(splitFollowUps(lastAnswer).answer);
    if (code === null) {
      flashNotice("No code block in the last answer.");
      return;
    }
    try {
      await writeText(code);
      flashNotice("Code copied to the clipboard.");
    } catch (error) {
      flashNotice(`Couldn't copy: ${error}`);
    }
  }, [flashNotice]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= QUICK_ACTIONS.length) return;
      e.preventDefault();
      runQuickAction(QUICK_ACTIONS[index].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runQuickAction, isPopoverOpen]);

  const processSelectionRef = useRef<((base64: string) => Promise<void>) | null>(null);
  processSelectionRef.current = async (base64: string) => {
    const config = screenshotConfigRef.current;

    try {
      const audio = await captureShortcutAudio();

      if (config.mode === "auto") {
        await handleScreenshotSubmit(
          base64,
          config.autoPrompt,
          audio?.audioBase64,
          audio?.transcript
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
    globalShortcuts.registerCustomShortcutCallback("copy_code", () => void copyLastCode());
    globalShortcuts.registerCustomShortcutCallback("toggle_auto_answer", () => {
      setTranscriptionConfig({ autoAnswer: !getTranscriptionConfig().autoAnswer });
    });
    globalShortcuts.registerCustomShortcutCallback("new_conversation", () => {
      startNewConversation();
      setKeepEngaged(false);
    });
    return () => {
      globalShortcuts.unregisterCustomShortcutCallback("toggle_system_audio");
      globalShortcuts.unregisterCustomShortcutCallback("new_conversation");
      globalShortcuts.unregisterCustomShortcutCallback("copy_code");
      globalShortcuts.unregisterCustomShortcutCallback("toggle_auto_answer");
    };
  }, [
    globalShortcuts.registerInputRef,
    globalShortcuts.registerScreenshotCallback,
    globalShortcuts.registerCustomShortcutCallback,
    globalShortcuts.unregisterCustomShortcutCallback,
    captureScreenshot,
    copyLastCode,
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
    pinNotice,
    actionNotice,
    runQuickAction,
    askFollowUp,
    copyLastCode,
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
