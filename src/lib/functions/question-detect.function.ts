const QUESTION_START =
  /^(what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|are you|were you|is there|are there|tell me|walk me through|talk me through|explain|describe|give me|share|what's|how's)\b/i;

/** Filler that ends in "?" but doesn't need an answer. */
const NOT_A_QUESTION =
  /^(right|okay|ok|yeah|yes|no|really|you know|make sense|does that make sense|can you hear me|am i audible|is that clear|any questions|sorry|hello|hi|what)\??$/i;

/** Whether a finished transcript line reads like a question worth answering. */
export function looksLikeQuestion(text: string): boolean {
  const line = text.trim().replace(/^[-–—\s]+/, "");
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 3 || NOT_A_QUESTION.test(line)) return false;
  if (line.endsWith("?")) return true;
  return QUESTION_START.test(line) && words.length >= 5;
}

export interface QuestionDetectorOptions {
  /** Called with the question once the speaker has paused, and when they stopped speaking. */
  onQuestion: (question: string, endedAt: number) => void;
  /** Silence after the question before answering, so follow-on clauses are included. */
  pauseMs?: number;
  /** Safety cap against noisy audio: most answers in any 60 seconds. */
  maxPerMinute?: number;
}

/**
 * Watches finished lines from other participants and fires once a question has
 * been asked and they've stopped talking. Lines that continue a pending
 * question are appended to it.
 */
export function createQuestionDetector({
  onQuestion,
  pauseMs = 1800,
  maxPerMinute = 6,
}: QuestionDetectorOptions) {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired: number[] = [];
  let quietSinceLast = 0;

  const fire = () => {
    timer = undefined;
    // Over the cap: hold the question until the oldest answer is a minute old.
    const now = Date.now();
    fired = fired.filter((t) => now - t < 60_000);
    if (fired.length >= maxPerMinute) {
      timer = setTimeout(fire, fired[0] + 60_000 - now);
      return;
    }
    const question = pending.join(" ").trim();
    pending = [];
    if (!question) return;
    fired.push(now);
    onQuestion(question, quietSinceLast);
  };

  const arm = (quietSince = Date.now()) => {
    clearTimeout(timer);
    quietSinceLast = quietSince;
    const elapsed = Math.min(Math.max(0, Date.now() - quietSince), pauseMs);
    timer = setTimeout(fire, pauseMs - elapsed);
  };

  return {
    /**
     * A finished line from another participant. `endedAt` (ms since epoch) is
     * when they stopped speaking: transcription takes a moment, so part of the
     * pause has usually passed by the time the line arrives.
     */
    line(text: string, endedAt = Date.now()) {
      if (looksLikeQuestion(text)) {
        pending.push(text.trim());
        arm(endedAt);
      } else if (pending.length > 0) {
        // They kept talking: keep a little of it with the question (it may be
        // context or a rephrase), but don't let a monologue grow without bound.
        if (pending.length < 4) pending.push(text.trim());
        arm(endedAt);
      }
    },
    /** They're still mid-sentence: hold off answering. */
    speaking() {
      if (pending.length > 0) arm();
    },
    dispose() {
      clearTimeout(timer);
      pending = [];
    },
  };
}
