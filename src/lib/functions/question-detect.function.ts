const QUESTION_START =
  /^(what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|are you|were you|is there|are there|tell me|walk me through|talk me through|explain|describe|give me|share|what's|how's)\b/i;

/** Filler that ends in "?" but doesn't need an answer. */
const NOT_A_QUESTION =
  /^(right|okay|ok|yeah|yes|no|really|you know|make sense|does that make sense|can you hear me|am i audible|is that clear|any questions|sorry|hello|hi|what)\??$/i;

/**
 * Questions that keep a conversation going but don't need a prepared answer:
 * greetings, checking who's on the line, audio/screen checks, scheduling and
 * setup, and "does that make sense?"-style confirmations.
 */
const SMALL_TALK = [
  // Greetings and how-are-you.
  /^(hi|hey|hello|good (morning|afternoon|evening))\b.{0,40}\bhow (are|r) (you|u|things)\b/,
  /^how (are|r) (you|u|things)( doing| going)?( today| this (morning|afternoon|evening))?$/,
  /^how('s| is) (it going|everything|your day|your (morning|afternoon|week|weekend))\b/,
  /^how (was|were) your (day|morning|weekend|week|trip|holiday|vacation)\b/,
  /^(are you|you) (doing )?(well|good|ok|okay|alright)$/,
  /^(nice|good|great|lovely) to (meet|see|talk to) you\b/,
  // Who's on the line ("Is this Nolan?" is matched separately, by the capital).
  /^(is that|is it) (you|me)$/,
  // Audio, video and screen checks.
  /\bcan (you|everyone|everybody) (hear|see) (me|us|it|this|that|my screen|the screen|what i)\b/,
  /\b(do|did|can) you see (it|that|this|what i|my|the (screen|link|editor|doc|document|message|chat))\b/,
  /\bis (my|the) (audio|video|screen|mic|microphone|camera|connection|sound)\b/,
  /\b(am i|are you) (on mute|muted|audible|breaking up|frozen)\b/,
  /\bmake sure (that )?(i|you|we) can (see|hear)\b/,
  /\b(can|could) you (just )?(type|write) (something|anything|hello|hi)\b/,
  /\b(did|have) you (get|got|receive|see) (the|my) (link|invite|email|message|calendar)\b/,
  /\b(are you|you're) (next to|near|at|on) (a |your )?(computer|laptop|desk|keyboard)\b/,
  // Scheduling and getting started.
  /\bis (now|this|it) (still )?(a )?(good|okay|ok|fine|convenient) time\b/,
  /\b(do you|you) (still )?have (a (minute|moment|second|few minutes)|time)\b/,
  /^(are you|you) (ready|all set|set)( to (start|begin|go|get started))?$/,
  /^(shall|should|can|could) (we|i) (get started|start|begin|go ahead|kick off|jump in|dive in)\b/,
  /^(why don't|what if) (i|we) (go ahead|start|begin|just|read|share|send|jump|kick)\b/,
  /^(mind if|do you mind if) i\b/,
  // Confirmations and check-ins.
  /^(does|did) (that|this|it) (make sense|sound (good|ok|okay|right|fair)|work( for you)?)$/,
  /^(sound|sounds) (good|ok|okay|right|fair)$/,
  /^(is that|that) (ok|okay|alright|fine|clear|cool)( with you)?$/,
  /^any (questions|thoughts)( so far| before we (start|begin|move on))?$/,
  /^(are you|you) (still )?(there|with me)$/,
  /^(can|could) you repeat (that|the question)$/,
];

/** Minimum wait after a line, so the rest of its chunk arrives first. */
const SETTLE_MS = 150;

/** Start of a reply, meaning the question was answered before we could. */
const ANSWER_START =
  /^(yes|yeah|yep|yup|yea|sure|no|nope|nah|of course|absolutely|definitely|certainly|sounds good|sounds great|great|perfect|awesome|okay|ok|alright|all right|got it|i am|i'm|i do|i can|i see|i did|i have|we are|we do|we can|hey|hi|hello|thanks|thank you|mm-hmm|uh-huh|good|fine|not bad|doing well)\b/;

/** Words people start sentences with that don't change what's being asked. */
const LEADING_FILLER =
  /^((so|and|but|okay|ok|alright|all right|well|um|uh|erm|hmm|mmm?|mm-hmm|now|right|cool|great|perfect|awesome|interesting|got it|i see|sure|nice)[,.!]?\s+)+/i;

/** "Is this Nolan?" / "Am I speaking with Grace Lee?" (checked before lowercasing). */
const WHO_IS_THIS = /^([Ii]s this|[Aa]m [Ii] (speaking|talking) (with|to)) [A-Z][a-z]+( [A-Z][a-z]+)?\??$/;

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/^[-–—\s]+/, "")
    .replace(/[“”"']/g, "'")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_FILLER, "");

/** Split a transcript line into sentences, keeping their punctuation. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether a finished transcript line reads like a question worth answering. */
export function looksLikeQuestion(text: string): boolean {
  const line = text.trim().replace(/^[-–—\s]+/, "");
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 3 || NOT_A_QUESTION.test(line)) return false;
  if (line.endsWith("?")) return true;
  // Transcription often drops the "?"; a question word after any filler
  // ("Mmm, interesting, why a…") still marks a question.
  const core = line.replace(LEADING_FILLER, "");
  return QUESTION_START.test(core) && core.split(/\s+/).length >= 5;
}

/** Greetings, logistics and check-ins that don't need a prepared answer. */
export function isSmallTalk(question: string): boolean {
  // Whisper often joins sentences with commas ("…from Jane Street, is this
  // Nolan?"), so also judge the last clause on its own.
  const clauses = question.split(/[,;]\s+/);
  const candidates = clauses.length > 1 ? [question, clauses[clauses.length - 1]] : [question];
  return candidates.some((candidate) => {
    const asSaid = candidate.trim().replace(/^[-–—\s]+/, "").replace(LEADING_FILLER, "");
    if (WHO_IS_THIS.test(asSaid)) return true;
    const q = normalize(candidate);
    return SMALL_TALK.some((pattern) => pattern.test(q));
  });
}

/** Whether a line starts like an answer to what was just asked. */
export const looksLikeAnswer = (text: string) => ANSWER_START.test(normalize(text));

export interface QuestionDetectorOptions {
  /** Called with the question once the speaker has paused, and when they stopped speaking. */
  onQuestion: (question: string, endedAt: number) => void;
  /** Called instead when a question is dropped, with the reason (for logging). */
  onSkip?: (question: string, reason: "answered" | "small talk") => void;
  /** Silence after the question before answering, so follow-on clauses are included. */
  pauseMs?: number;
  /** Safety cap against noisy audio: most answers in any 60 seconds. */
  maxPerMinute?: number;
}

/**
 * Watches finished lines from other participants and fires once a question has
 * been asked and they've stopped talking. Lines that continue a pending
 * question are appended to it. A question is dropped when someone answers it
 * first (a reply starting "yes", "sure", "I am"…, or a different voice), or
 * when it's small talk.
 */
export function createQuestionDetector({
  onQuestion,
  onSkip,
  pauseMs = 1800,
  maxPerMinute = 6,
}: QuestionDetectorOptions) {
  /** Question sentences, then any context that followed from the same speaker. */
  let pending: string[] = [];
  let questions: string[] = [];
  let pendingSpeaker: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired: number[] = [];
  let quietSinceLast = 0;

  const reset = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = [];
    questions = [];
    pendingSpeaker = undefined;
  };

  const drop = (reason: "answered" | "small talk") => {
    const question = pending.join(" ").trim();
    reset();
    if (question) onSkip?.(question, reason);
  };

  const fire = () => {
    timer = undefined;
    // Over the cap: hold the question until the oldest answer is a minute old.
    const now = Date.now();
    fired = fired.filter((t) => now - t < 60_000);
    if (fired.length >= maxPerMinute) {
      timer = setTimeout(fire, fired[0] + 60_000 - now);
      return;
    }
    if (pending.length === 0) return;
    if (questions.every(isSmallTalk)) return drop("small talk");
    const question = pending.join(" ").trim();
    reset();
    fired.push(now);
    onQuestion(question, quietSinceLast);
  };

  const arm = (quietSince = Date.now()) => {
    clearTimeout(timer);
    quietSinceLast = quietSince;
    const elapsed = Math.max(0, Date.now() - quietSince);
    // Lines from one transcribed chunk arrive a few ms apart; let the rest of
    // the chunk (maybe the answer) through before deciding.
    timer = setTimeout(fire, Math.max(SETTLE_MS, pauseMs - elapsed));
  };

  return {
    /**
     * A finished line from another participant. `endedAt` (ms since epoch) is
     * when they stopped speaking: transcription takes a moment, so part of the
     * pause has usually passed by the time the line arrives. `speaker` is the
     * voice label when speakers are told apart.
     */
    line(text: string, endedAt = Date.now(), speaker?: string) {
      const parts = sentences(text);
      if (parts.length === 0) return;
      let lastQuestion = -1;
      parts.forEach((part, i) => {
        if (looksLikeQuestion(part)) lastQuestion = i;
      });

      if (pending.length > 0) {
        const otherVoice = Boolean(speaker && pendingSpeaker && speaker !== pendingSpeaker);
        // Someone replied before we answered (often both sides are in the
        // meeting audio): leave it.
        if (lastQuestion < 0 && (otherVoice || looksLikeAnswer(parts[0]))) return drop("answered");
        if (otherVoice) reset();
      }

      if (lastQuestion >= 0) {
        const after = parts.slice(lastQuestion + 1);
        // Asked and answered within one transcribed line.
        if (after.length > 0 && looksLikeAnswer(after[0])) {
          pending.push(...parts.slice(0, lastQuestion + 1));
          questions.push(parts[lastQuestion]);
          return drop("answered");
        }
        pending.push(...parts);
        questions.push(...parts.filter(looksLikeQuestion));
        pendingSpeaker = speaker ?? pendingSpeaker;
        arm(endedAt);
      } else if (pending.length > 0) {
        // They kept talking: keep a little of it with the question (it may be
        // context or a rephrase), but don't let a monologue grow without bound.
        if (pending.length < 6) pending.push(text.trim());
        arm(endedAt);
      }
    },
    /** They're still mid-sentence: hold off answering. */
    speaking() {
      if (pending.length > 0) arm();
    },
    dispose() {
      reset();
    },
  };
}
