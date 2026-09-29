const EPHEMERAL = { type: "ephemeral" } as const;

const isAnthropic = (url: string, headers: Record<string, string>) =>
  /(^|\.)anthropic\.com\//.test(url.replace(/^https?:\/\//, "")) ||
  Object.keys(headers).some((h) => h.toLowerCase() === "anthropic-version");

/** Mark the last block of `content` (string or block list) as a cache breakpoint. */
function markLastBlock(content: unknown): unknown {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content, cache_control: EPHEMERAL }] : content;
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = [...content];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
    return blocks;
  }
  return content;
}

/**
 * Anthropic only reuses a prompt prefix when it's marked. Mark the system
 * prompt (instructions plus personal context, the same on every request) and
 * the end of the earlier conversation, so follow-ups are read from cache.
 * OpenAI and Gemini cache repeated prefixes automatically. Prompts shorter
 * than the provider's minimum are simply not cached.
 */
export function addPromptCacheBreakpoints(
  body: any,
  url: string,
  headers: Record<string, string>
): any {
  if (!body || typeof body !== "object" || !isAnthropic(url, headers)) return body;
  const next = { ...body };
  if (next.system !== undefined) next.system = markLastBlock(next.system);
  if (Array.isArray(next.messages) && next.messages.length >= 2) {
    const messages = [...next.messages];
    const i = messages.length - 2;
    messages[i] = { ...messages[i], content: markLastBlock(messages[i].content) };
    next.messages = messages;
  }
  return next;
}
