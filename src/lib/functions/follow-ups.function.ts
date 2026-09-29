const MARKER = "[[follow-ups]]";
const MAX_FOLLOW_UPS = 3;
const MAX_LENGTH = 160;

/** Added to the system prompt for overlay answers when follow-ups are on. */
export const FOLLOW_UP_INSTRUCTIONS = `After your answer, on a new line write exactly ${MARKER} and then two or three short follow-up questions, one per line, without numbering or bullets: the questions most likely to come next in this conversation, either what the other person may ask next or what the user should ask. Write nothing after them.`;

/**
 * Split an answer from the follow-up questions after the marker. While an
 * answer is streaming, a partly written marker at the end is hidden too.
 */
export function splitFollowUps(text: string): { answer: string; followUps: string[] } {
  const at = text.toLowerCase().lastIndexOf(MARKER);
  if (at >= 0) {
    const followUps = text
      .slice(at + MARKER.length)
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 0 && line.length <= MAX_LENGTH)
      .slice(0, MAX_FOLLOW_UPS);
    return { answer: text.slice(0, at).trimEnd(), followUps };
  }
  const lastBreak = text.lastIndexOf("\n");
  const tail = text.slice(lastBreak + 1).trim().toLowerCase();
  if (tail.startsWith("[[") && MARKER.startsWith(tail)) {
    return { answer: text.slice(0, lastBreak + 1).trimEnd(), followUps: [] };
  }
  return { answer: text, followUps: [] };
}
