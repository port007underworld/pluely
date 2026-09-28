import { useState, useCallback, useRef, useEffect } from "react";
import { useApp } from "@/contexts";
import { MAX_FILES } from "@/config";
import {
  fetchAIResponse,
  appendMessages,
  buildBudgetedHistory,
  getConversationSettings,
  getConversationById,
  generateConversationTitle,
  shouldUseRunningbordAPI,
  MESSAGE_ID_OFFSET,
  generateMessageId,
  generateRequestId,
  getResponseSettings,
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

interface ChatCompletionState {
  input: string;
  isLoading: boolean;
  error: string | null;
  attachedFiles: AttachedFile[];
}

export const useChatCompletion = (
  conversationId: string,
  messages: ChatConversation | null,
  setMessages: (messages: ChatConversation | null) => void
) => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
    hasActiveLicense,

  } = useApp();

  const [state, setState] = useState<ChatCompletionState>({
    input: "",
    isLoading: false,
    error: null,
    attachedFiles: [],
  });

  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);
  const isProcessingScreenshotRef = useRef(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
  const screenshotInitiatedByThisContext = useRef(false);

  useEffect(() => {
    screenshotConfigRef.current = screenshotConfiguration;
  }, [screenshotConfiguration]);

  const scrollToBottom = () => {
    const responseSettings = getResponseSettings();
    if (responseSettings.autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
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

  const submit = useCallback(
    async (speechText?: string) => {
      const input = speechText || state.input;

      if (!input.trim()) {
        return;
      }

      if (speechText) {
        setState((prev) => ({
          ...prev,
          input: speechText,
        }));
      }

      // Generate unique request ID
      const requestId = generateRequestId();
      currentRequestIdRef.current = requestId;

      // Cancel any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        // auto-attach-to-every-request feature removed — screenshots will only be captured when explicitly requested (screenshot button / shortcut).
        // Prepare message history for the AI
        const messageHistory = buildBudgetedHistory(
          messages?.messages || [],
          getConversationSettings().historyBudgetTokens,
          input
        ).messages;


      // Extract both images and audio from attached files
        const imagesBase64 = state.attachedFiles
          .filter(f => f.type.startsWith('image/'))
          .map(f => f.base64);

        const audioBase64 = state.attachedFiles
          .filter(f => f.type.startsWith('audio/'))
          .map(f => f.base64)[0]; // Gemini handles one audio file per turn in this logic

        // If we captured a screenshot earlier in this flow, include it as well

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

        // Add user message to UI immediately
        const timestamp = Date.now();
        const userMsg: ChatMessage = {
          id: generateMessageId("user", timestamp),
          role: "user",
          content: input,
          timestamp,
        };

        const updatedMessages = {
          ...messages!,
          messages: [...(messages?.messages || []), userMsg],
        };
        setMessages(updatedMessages);

        // Clear input and set loading state
        setState((prev) => ({
          ...prev,
          input: "",
          isLoading: true,
          error: null,
          attachedFiles: [],
        }));

        // Scroll to bottom after adding user message
        setTimeout(scrollToBottom, 100);

        let fullResponse = "";

        try {
          // Use the fetchAIResponse function with signal
          for await (const chunk of fetchAIResponse({
            provider: useRunningbordAPI ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage: input,
            imagesBase64,
            audioBase64,
            signal,
            requestId,
          })) {
            // Only update if this is still the current request
            if (currentRequestIdRef.current !== requestId) {
              return; // Request was superseded, stop processing
            }

            // Check if request was aborted
            if (signal.aborted) {
              return; // Request was cancelled, stop processing
            }

            fullResponse += chunk;

            // Update the last message (assistant's response) in real-time
            const assistantMsg: ChatMessage = {
              id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
              role: "assistant",
              content: fullResponse,
              timestamp: timestamp + MESSAGE_ID_OFFSET,
            };

            const updatedWithResponse = {
              ...updatedMessages,
              messages: [...updatedMessages.messages, assistantMsg],
            };

            // Check if assistant message already exists
            const lastMessage =
              updatedWithResponse.messages[
                updatedWithResponse.messages.length - 1
              ];
            if (lastMessage.role === "assistant") {
              // Update existing assistant message
              updatedWithResponse.messages[
                updatedWithResponse.messages.length - 1
              ] = assistantMsg;
            } else {
              // Add new assistant message
              updatedWithResponse.messages.push(assistantMsg);
            }

            setMessages(updatedWithResponse);

            // Auto-scroll during streaming
            scrollToBottom();
          }
        } catch (e: any) {
          // Only show error if this is still the current request and not aborted
          if (currentRequestIdRef.current === requestId && !signal.aborted) {
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: e.message || "An error occurred",
            }));
          }
          return;
        }

        // Only proceed if this is still the current request
        if (currentRequestIdRef.current !== requestId || signal.aborted) {
          return;
        }

        setState((prev) => ({ ...prev, isLoading: false }));

        // Focus input after AI response is complete
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);

        // Save the conversation after successful completion
        if (fullResponse) {
          const assistantMsg: ChatMessage = {
            id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
            role: "assistant",
            content: fullResponse,
            timestamp: timestamp + MESSAGE_ID_OFFSET,
          };

          try {
            // Append-only: never rewrites earlier turns, even if `messages` is stale.
            await appendMessages(
              {
                id: conversationId,
                title: messages?.title || generateConversationTitle(input),
                createdAt: messages?.createdAt || timestamp,
              },
              [userMsg, assistantMsg]
            );

            // Reload conversation from database to ensure consistency
            const updatedConversation = await getConversationById(
              conversationId
            );
            if (updatedConversation) {
              setMessages(updatedConversation);
            }
          } catch (error) {
            console.error("Failed to save conversation:", error);
            setState((prev) => ({
              ...prev,
              error: "Failed to save conversation. Please try again.",
            }));
          }
        }
      } catch (error) {
        // Only show error if not aborted
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
      state.attachedFiles,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      messages,
      conversationId,
      setMessages,
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);

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
    async (base64: string, prompt?: string, audioBase64?: string | undefined, audioTranscription?: string | null) => {
      if (state.attachedFiles.length >= MAX_FILES) {
        setState((prev) => ({
          ...prev,
          error: `You can only upload ${MAX_FILES} files`,
        }));
        return;
      }

      try {
        if (prompt) {
          // Auto mode: Submit directly to AI with screenshot (and optional audio)
          const attachedFile: AttachedFile = {
            id: Date.now().toString(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          let audioAttachedFile: AttachedFile | undefined = undefined;
          if (audioBase64 && state.attachedFiles.length < MAX_FILES) {
            audioAttachedFile = {
              id: Date.now().toString() + "_audio",
              name: `screenshot_audio_${Date.now()}.wav`,
              type: "audio/wav",
              base64: audioBase64,
              size: audioBase64.length,
            };
          }

          // Store files temporarily and submit
          setState((prev) => ({
            ...prev,
            attachedFiles: audioAttachedFile
              ? [...prev.attachedFiles, attachedFile, audioAttachedFile]
              : [...prev.attachedFiles, attachedFile],
            input: prompt,
          }));

          // If we have a transcription from the audio, append it to the input before submitting
          const promptForSubmit = audioTranscription && audioTranscription.trim()
            ? `${prompt}\n\n[Attached audio transcription]: ${audioTranscription}`
            : prompt;

          // Submit with the prompt and screenshot
          setTimeout(() => submit(promptForSubmit), 100);
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
            attachedFiles: audioBase64
              ? [...prev.attachedFiles, attachedFile, {
                  id: Date.now().toString() + "_audio",
                  name: `screenshot_audio_${Date.now()}.wav`,
                  type: "audio/wav",
                  base64: audioBase64,
                  size: audioBase64.length,
                }]
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
    [state.attachedFiles.length, submit]
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

  const captureScreenshot = useCallback(async () => {
    if (!handleScreenshotSubmit) return;

    const config = screenshotConfigRef.current;

    // Mark that this context initiated the screenshot
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
        const config = screenshotConfigRef.current;
        const base64 = await invoke("capture_to_base64", {
          compressionEnabled: config.compressionEnabled ?? true,
          compressionQuality: config.compressionQuality ?? 75,
          compressionMaxDimension: config.compressionMaxDimension ?? 1600,
        });

        if (config.mode === "auto") {
          // Auto mode: Submit directly to AI with the configured prompt
          await handleScreenshotSubmit(base64 as string, config.autoPrompt);
        } else if (config.mode === "manual") {
          // Manual mode: Add to attached files without prompt
          await handleScreenshotSubmit(base64 as string);
        }
        // Reset flag after processing
        screenshotInitiatedByThisContext.current = false;
      } else {
        // Selection Mode: Open overlay to select an area
        // Only allow if user has active license
        if (!hasActiveLicense) {
          setState((prev) => ({
            ...prev,
            error: "Selection mode requires an active license",
          }));
          setIsScreenshotLoading(false);
          screenshotInitiatedByThisContext.current = false;
          return;
        }
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
  }, [handleScreenshotSubmit, hasActiveLicense]);

  const processSelectionRef = useRef<((base64: string) => Promise<void>) | null>(null);
  processSelectionRef.current = async (base64: string) => {
    const config = screenshotConfigRef.current;
    try {
      if (config.mode === "auto") {
        await handleScreenshotSubmit(base64, config.autoPrompt);
      } else if (config.mode === "manual") {
        await handleScreenshotSubmit(base64);
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

  // Subscribe once and dispatch through a ref so an unresolved listen() can't
  // outlive cleanup and fire with stale conversation state.
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

  useEffect(() => {
    const unlisten = listen("capture-closed", () => {
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

  return {
    input: state.input,
    setInput,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles: state.attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    submit,
    cancel,
    setState,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles,
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    messagesEndRef,
    hasActiveLicense,
  };
};
