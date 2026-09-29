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
  /** Called with the question once the speaker has paused. */
  onQuestion: (question: string) => void;
  /** Silence after the question before answering, so follow-on clauses are included. */
  pauseMs?: number;
  /** Minimum time between automatic answers. */
  cooldownMs?: number;
}

/**
 * Watches finished lines from other participants and fires once a question has
 * been asked and they've stopped talking. Lines that continue a pending
 * question are appended to it.
 */
export function createQuestionDetector({
  onQuestion,
  pauseMs = 1800,
  cooldownMs = 20_000,
}: QuestionDetectorOptions) {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFired = 0;

  const fire = () => {
    timer = undefined;
    // Too soon after the last answer: hold the question until the cooldown ends.
    const wait = lastFired + cooldownMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(fire, wait);
      return;
    }
    const question = pending.join(" ").trim();
    pending = [];
    if (!question) return;
    lastFired = Date.now();
    onQuestion(question);
  };

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(fire, pauseMs);
  };

  return {
    /** A finished line from another participant. */
    line(text: string) {
      if (looksLikeQuestion(text)) {
        pending.push(text.trim());
        arm();
      } else if (pending.length > 0) {
        // They kept talking: keep a little of it with the question (it may be
        // context or a rephrase), but don't let a monologue grow without bound.
        if (pending.length < 4) pending.push(text.trim());
        arm();
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
