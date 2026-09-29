import { Message } from "@/types";

export function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  return path
    .replace(/\[/g, ".")
    .replace(/\]/g, "")
    .split(".")
    .reduce((o, k) => (o || {})[k], obj);
}

export function setByPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i].replace(/\[(\d+)\]/g, ".$1");
    if (!current[key]) current[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    current = current[key];
  }
  current[keys[keys.length - 1].replace(/\[(\d+)\]/g, ".$1")] = value;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      const base64data = (reader.result as string)?.split(",")[1] ?? "";
      resolve(base64data);
    };
    reader.onerror = reject;
  });
}

export function extractVariables(
  curl: string,
  includeAll = false
): { key: string; value: string }[] {
  if (typeof curl !== "string") {
    return [];
  }

  const regex = /\{\{([A-Z_]+)\}\}/g;
  const matches = curl?.match(regex) || [];
  const variables = matches
    .map((match) => {
      if (typeof match === "string") {
        return match.slice(2, -2);
      }
      return "";
    })
    .filter((v) => v !== "");

  const uniqueVariables = [...new Set(variables)];

  const doNotInclude = includeAll
    ? []
    : ["SYSTEM_PROMPT", "TEXT", "IMAGE", "AUDIO"];

  const filteredVariables = uniqueVariables?.filter(
    (variable) => !doNotInclude?.includes(variable)
  );

  return filteredVariables.map((variable) => ({
    key: variable?.toLowerCase()?.replace(/_/g, "_") || "",
    value: variable,
  }));
}


/**
 * Recursively processes a user message template to replace placeholders for text, images, and audio.
 * @param template The user message template object.
 * @param userMessage The user's text message.
 * @param imagesBase64 An array of base64 encoded images.
 * @param audioBase64 A base64 encoded audio string (optional).
 * @returns The processed user message object.
 */
export function processUserMessageTemplate(
  template: any,
  userMessage: string,
  imagesBase64: string[] = [],
  audioBase64: string = ""
): any {
  // Helper to safely inject text into JSON strings without breaking structure
  const escapeForJson = (value: string) =>
    JSON.stringify(value ?? "").slice(1, -1);

  // 1. Initial Text Replacement
  const templateStr = JSON.stringify(template).replace(
    /\{\{TEXT\}\}/g,
    escapeForJson(userMessage)
  );
  const result = JSON.parse(templateStr);

  // 2. Recursive Media Replacer
  const mediaReplacer = (node: any): any => {
    if (Array.isArray(node)) {
      // Find where media placeholders are hidden in the array (e.g., Gemini parts)
      const audioIndex = node.findIndex((item) => JSON.stringify(item).includes("{{AUDIO}}"));

      let finalArray = [...node];

      // Handle Audio Replacement (Single)
      if (audioIndex > -1) {
        if (audioBase64 && audioBase64.trim() !== "") {
          const cleanAudio = audioBase64.replace(/^data:.*;base64,/, "");
          const audioStr = JSON.stringify(finalArray[audioIndex]).replace(/\{\{AUDIO\}\}/g, cleanAudio);
          finalArray[audioIndex] = JSON.parse(audioStr);
        } else {
          // If no audio provided, remove the placeholder object entirely to prevent 400 errors
          finalArray.splice(audioIndex, 1);
          // Recalculate imageIndex if audio was before it
          return mediaReplacer(finalArray); 
        }
      }

      // Handle Image Replacement (Multiple)
      // Note: Re-calculating index because the array might have shrunk from audio removal
      const currentImageIndex = finalArray.findIndex((item) => JSON.stringify(item).includes("{{IMAGE}}"));
      if (currentImageIndex > -1) {
        if (imagesBase64.length > 0) {
          const imageTemplate = finalArray[currentImageIndex];
          const imageParts = imagesBase64.map((img) => {
            const cleanImg = img.replace(/^data:.*;base64,/, "");
            const partStr = JSON.stringify(imageTemplate).replace(/\{\{IMAGE\}\}/g, cleanImg);
            return JSON.parse(partStr);
          });
          
          finalArray = [
            ...finalArray.slice(0, currentImageIndex),
            ...imageParts,
            ...finalArray.slice(currentImageIndex + 1),
          ];
        } else {
          // Remove empty image placeholders
          finalArray.splice(currentImageIndex, 1);
        }
      }

      return finalArray.map(mediaReplacer);
    } 
    
    // Recursive object walk
    else if (node && typeof node === "object") {
      const newNode: { [key: string]: any } = {};
      for (const key in node) {
        newNode[key] = mediaReplacer(node[key]);
      }
      return newNode;
    }
    return node;
  };

  return mediaReplacer(result);
}

export function buildDynamicMessages(
  messagesTemplate: any[],
  history: Message[],
  userMessage: string,
  imagesBase64: string[] = [],
  audioBase64: string = "" // Note: Simplified to string for a single file, or keep as array if your UI supports it
): any[] {
  // Detect if the template is Gemini-style (uses 'parts') or standard (uses 'content')
  const isGeminiStyle = messagesTemplate.some((m) => !!m.parts);

  const userMessageTemplateIndex = messagesTemplate.findIndex((m) =>
    JSON.stringify(m).includes("{{TEXT}}")
  );

  if (userMessageTemplateIndex === -1) {
    // Standard fallback if no template is found
    return [...history, { role: "user", content: userMessage }];
  }

  // 1. Format history based on the provider's style
  const formattedHistory = history.map((msg) => {
    if (isGeminiStyle) {
      return {
        // Gemini strictly uses "model" role for AI responses
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }]
      };
    }
    // Standard format (OpenAI, Anthropic, etc.)
    return { role: msg.role, content: msg.content };
  });

  const prefixMessages = messagesTemplate.slice(0, userMessageTemplateIndex);
  const suffixMessages = messagesTemplate.slice(userMessageTemplateIndex + 1);
  const userMessageTemplate = messagesTemplate[userMessageTemplateIndex];

  // 2. Process current multimodal message
  const newUserMessage = processUserMessageTemplate(
    userMessageTemplate,
    userMessage,
    imagesBase64,
    audioBase64 
  );

  // 3. Assemble: [System/Prefixes] + [History] + [Current Turn] + [Suffixes]
  return [...prefixMessages, ...formattedHistory, newUserMessage, ...suffixMessages];
}

/**
 * Recursively walks through an object and replaces variable placeholders.
 * @param node The object or value to process.
 * @param variables A key-value map of variables to replace.
 * @returns The processed object.
 */
export function deepVariableReplacer(
  node: any,
  variables: Record<string, string>
): any {
  if (typeof node === "string") {
    let result = node;
    for (const [key, value] of Object.entries(variables)) {
      // Match normal {{KEY}} placeholders
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      // Match URL-encoded %7B%7BKEY%7D%7D placeholders (curl parsers encode braces in URLs)
      result = result.replace(new RegExp(`%7B%7B${key}%7D%7D`, "gi"), value);
    }
    return result;
  }
  if (Array.isArray(node)) {
    return node.map((item) => deepVariableReplacer(item, variables));
  }
  if (node && typeof node === "object") {
    const newNode: { [key: string]: any } = {};
    for (const key in node) {
      newNode[key] = deepVariableReplacer(node[key], variables);
    }
    return newNode;
  }
  return node;
}

/**
 * Extracts content from a streaming API response chunk by trying a series of common JSON paths.
 * This makes the system more resilient to variations in streaming formats.
 * @param chunk The parsed JSON object from a stream line.
 * @param defaultPath The default, non-streaming content path for the provider.
 * @returns The extracted text content, or null if not found.
 */
export function getStreamingContent(
  chunk: any,
  defaultPath: string
): string | null {
  // A set of possible paths to check for streaming content.
  // Using a Set automatically handles duplicates.
  const possiblePaths = new Set([
    // 1. First, try a common modification for OpenAI-like providers.
    defaultPath.replace(".message.", ".delta."),
    // 2. Then, add other common patterns.
    "choices[0].delta.content", // OpenAI, Groq, Mistral, Perplexity
    "candidates[0].content.parts[0].text", // Gemini
    "delta.text", // Claude
    "text", // Cohere
    // 3. Finally, use the original path as a fallback (for Gemini and others).
    defaultPath,
  ]);

  for (const path of possiblePaths) {
    // Skip empty or null paths
    if (!path) continue;

    const content = getByPath(chunk, path);

    // We only care about non-empty string content.
    // Some paths might resolve to objects (e.g., `choices[0].delta`), so we check the type.
    if (typeof content === "string" && content) {
      return content;
    }
  }

  // Return null if no content is found after trying all paths.
  return null;
}

export function textToBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToText(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

/**
 * Request URL from a parsed curl: curl-to-json moves the query string into
 * `params`, so put it back with variables (e.g. {{API_KEY}}) filled in.
 */
export function buildRequestUrl(
  curlJson: { url?: string; params?: Record<string, unknown> },
  variables: Record<string, string>
): string {
  let url = deepVariableReplacer(curlJson.url || "", variables);
  const params = Object.fromEntries(
    Object.entries(curlJson.params || {}).map(([key, value]) => [
      key,
      typeof value === "string" ? decodeURIComponent(value) : String(value),
    ])
  );
  const query = new URLSearchParams(deepVariableReplacer(params, variables)).toString();
  if (query) url += (url.includes("?") ? "&" : "?") + query;
  return url;
}

/**
 * Google's generateContent APIs (Gemini, Vertex AI) choose streaming by URL
 * (":streamGenerateContent") and reject a "stream" field in the body.
 */
export const streamsViaUrl = (url: string) => /:streamGenerateContent\b/i.test(url);

/** For URL-selected streaming, ask for SSE ("data: {...}" lines), which the reader parses. */
export function withSseParam(url: string): string {
  if (!streamsViaUrl(url) || /[?&]alt=/i.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "alt=sse";
}

/** Hide credentials passed as query parameters before logging a URL. */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&](?:key|api_key|apikey|access_token|token)=)[^&#]*/gi,
    "$1[redacted]"
  );
}
