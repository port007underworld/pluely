import { addPromptCacheBreakpoints } from "./prompt-cache.function";
import {
  buildDynamicMessages,
  buildRequestUrl,
  redactUrl,
  streamsViaUrl,
  withSseParam,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import {
  buildPersonalContextBlock,
  buildPinnedFactsBlock,
  getResponseSettings,
  RESPONSE_LENGTHS,
  LANGUAGES,
} from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";
import { firstLine, recordRequest, RequestLogEntry, truncateForLog } from "../request-log";

type NetworkFailureDetails = {
  requestId: string;
  providerId?: string;
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  errorName?: string;
  errorMessage?: string;
  responseBody?: string;
  headers?: Record<string, string>;
};

/**
 * Any header whose name looks secret is hidden. A fixed list of names missed
 * provider-specific ones (Google's x-goog-api-key was printed in full).
 */
const SECRET_HEADER = /(key|token|auth|secret|cookie|password|credential|session|signature)/i;

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SECRET_HEADER.test(key) ? "[redacted]" : value])
  );
}

function logNetworkFailure(details: NetworkFailureDetails): void {
  const payload = {
    ...details,
    headers: details.headers ? sanitizeHeaders(details.headers) : undefined,
  };
  console.error("[ai-response][network-failure]", payload);
}

function buildRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
}

function buildEnhancedSystemPrompt(baseSystemPrompt?: string): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  // Pinned facts go last: they change during a meeting, and keeping everything
  // before them identical preserves the prefix that providers cache.
  return [prompts.join(" "), buildPersonalContextBlock(), buildPinnedFactsBlock()]
    .filter(Boolean)
    .join("\n\n");
}

export interface AIRequestParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  audioBase64?: string;
  signal?: AbortSignal;
  /** Caller's request id, so UI, network logs and the Rust side share one id. */
  requestId?: string;
  /** Timings of the steps before this request, shown in Recent Requests. */
  steps?: { label: string; ms: number }[];
  /**
   * Send `systemPrompt` exactly as given, without response settings, personal
   * context, pinned facts or formatting rules (for small internal checks).
   */
  raw?: boolean;
}

const textLength = (content: Message["content"]) =>
  typeof content === "string" ? content.length : JSON.stringify(content).length;

/** Streams the model's answer and records what was sent in the local request log. */
export async function* fetchAIResponse(params: AIRequestParams): AsyncIterable<string> {
  const requestId = params.requestId ?? buildRequestId();
  const startedAt = Date.now();
  const started = performance.now();
  let firstChunkAt: number | undefined;
  let responseChars = 0;
  let status: RequestLogEntry["status"] = "cancelled";
  let error: string | undefined;

  try {
    for await (const chunk of streamAIResponse({ ...params, requestId })) {
      if (firstChunkAt === undefined) firstChunkAt = performance.now();
      responseChars += chunk.length;
      yield chunk;
    }
    status = params.signal?.aborted ? "cancelled" : "ok";
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    // A consumer that stops early (superseded request) lands here as "cancelled".
    const history = params.history ?? [];
    const images = params.imagesBase64 ?? [];
    const promptChars =
      (params.systemPrompt?.length ?? 0) +
      params.userMessage.length +
      history.reduce((sum, m) => sum + textLength(m.content), 0);
    recordRequest({
      requestId,
      startedAt,
      provider: params.provider?.id ?? "runningbord",
      status,
      error,
      historyMessages: history.length,
      historyRoles: history.map((m) => (m.role === "user" ? "U" : m.role === "assistant" ? "A" : "S")).join(""),
      estimatedPromptTokens: Math.ceil(promptChars / 4),
      images: images.length,
      imageBytes: images.reduce((sum, img) => sum + Math.floor((img.length * 3) / 4), 0),
      audioBytes: params.audioBase64 ? Math.floor((params.audioBase64.length * 3) / 4) : 0,
      hasTranscript: params.userMessage.includes("<meeting_transcript"),
      promptPreview: firstLine(params.userMessage).slice(0, 200),
      prompt: truncateForLog(params.userMessage),
      systemPrompt: truncateForLog(
        params.raw ? params.systemPrompt ?? "" : buildEnhancedSystemPrompt(params.systemPrompt)
      ),
      history: history.map((m) => ({
        role: m.role,
        content: truncateForLog(
          typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        ),
      })),
      responseChars,
      timeToFirstChunkMs:
        firstChunkAt === undefined ? undefined : Math.round(firstChunkAt - started),
      totalMs: Math.round(performance.now() - started),
      steps: params.steps,
    });
  }
}

async function* streamAIResponse(
  params: AIRequestParams & { requestId: string }
): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      audioBase64,
      signal,
    } = params;

    const { requestId } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = params.raw ? systemPrompt ?? "" : buildEnhancedSystemPrompt(systemPrompt);

    if (!provider) {
      throw new Error(`Provider not provided`);
    }

    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );

    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }

    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    if (audioBase64 && !provider.curl.includes("{{AUDIO}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support audio input`
      );
    }

    const allVariables: Record<string, any> = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };

    // Substitute variables into the template before any user/history content is
    // inserted, so message text containing "{{API_KEY}}" etc. is never expanded.
    let bodyObj: any = deepVariableReplacer(
      curlJson.data ? JSON.parse(JSON.stringify(curlJson.data)) : {},
      allVariables
    );

    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      bodyObj[messagesKey] = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64,
        audioBase64
      );
    }

    const cleanAudio = audioBase64
      ? audioBase64.replace(/^data:.*;base64,/, "")
      : "";
    for (const key of Object.keys(bodyObj)) {
      if (key !== messagesKey) {
        bodyObj[key] = deepVariableReplacer(bodyObj[key], { AUDIO: cleanAudio });
      }
    }

    let url = buildRequestUrl(curlJson, allVariables);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    bodyObj = addPromptCacheBreakpoints(bodyObj, url, headers);

    // OpenAI-style APIs opt into streaming with a "stream" body field; Google's
    // generateContent APIs choose it by URL and reject that field.
    if (provider?.streaming && streamsViaUrl(url)) {
      url = withSseParam(url);
    } else if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    let response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        return; // Silently return on abort
      }
      logNetworkFailure({
        requestId,
        providerId: provider?.id,
        url: redactUrl(url),
        method: curlJson.method || "POST",
        errorName: fetchError instanceof Error ? fetchError.name : undefined,
        errorMessage:
          fetchError instanceof Error ? fetchError.message : "Unknown error",
        headers: headers as Record<string, string>,
      });
      throw new Error(
        `Network error during API request: ${
          fetchError instanceof Error ? fetchError.message : "Unknown error"
        } (requestId: ${requestId})`
      );
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      logNetworkFailure({
        requestId,
        providerId: provider?.id,
        url: redactUrl(url),
        method: curlJson.method || "POST",
        status: response.status,
        statusText: response.statusText,
        responseBody: errorText ? errorText.slice(0, 2000) : undefined,
        headers: headers as Record<string, string>,
      });
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}${
          errorText ? ` - ${errorText}` : ""
        } (requestId: ${requestId})`
      );
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        throw new Error(
          `Failed to parse non-streaming response: ${
            parseError instanceof Error ? parseError.message : "Unknown error"
          } (requestId: ${requestId})`
        );
      }
      const content = getByPath(json, provider?.responseContentPath || "") || "";
      yield content;
      return;
    }

    if (!response.body) {
      throw new Error("Streaming not supported or response body missing");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      // Check if aborted
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // Check if aborted
        if (
          signal?.aborted ||
          (readError instanceof Error && readError.name === "AbortError")
        ) {
          return; // Silently return on abort
        }
        logNetworkFailure({
          requestId,
          providerId: provider?.id,
          url: redactUrl(url),
          method: curlJson.method || "POST",
          errorName: readError instanceof Error ? readError.name : undefined,
          errorMessage:
            readError instanceof Error ? readError.message : "Unknown error",
          headers: headers as Record<string, string>,
        });
        throw new Error(
          `Error reading stream: ${
            readError instanceof Error ? readError.message : "Unknown error"
          } (requestId: ${requestId})`
        );
      }
      const { done, value } = readResult;
      if (done) break;

      // Check if aborted before processing
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || ""
            );
            if (delta) {
              yield delta;
            }
          } catch (e) {
            // Ignore parsing errors for partial JSON chunks
          }
        }
      }
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}