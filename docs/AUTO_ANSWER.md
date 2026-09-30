# Auto-answer: what it can and can't do

An honest account of how automatic answers behave, based on replaying 20 recorded interviews (about 18 hours of audio) through the app. How it works in practice is in the [User Guide](USER_GUIDE.md#auto-answer); this note is about how well it works.

## What it does

With Meeting mode and live transcription on, Runningbord watches what **other people** say, detects when one of them has asked a question, waits for them to finish, and sends that question with the recent transcript to your AI provider.

Every automatic answer is a normal AI request, so the aim is to spend requests only on questions you'd actually want help with.

## How it decides

Everything below runs on your computer, before any request is made.

1. **Transcription.** Whisper turns the other side's audio into lines.
2. **Question detection.** A line counts as a question if it ends in "?", or opens like one ("why…", "how would…", "can you…", "walk me through…") after any filler ("Mmm, interesting, why…").
3. **Waiting.** It waits until they've stopped talking (1–5 seconds, your choice). The wait is measured from when they stopped, not from when the line was transcribed.
4. **Skipping.** It doesn't send a request for:
   - **Questions someone already answered.** The next line starts like a reply ("Yes", "Sure", "I am…"), or a different voice speaks next.
   - **Small talk and logistics.** "How are you?", "Is this Nolan?", "Can you hear me?", "Is now a good time?", "Which language will you code in?", "Any other questions?"
   - **Check-ins that are really statements.** "…so we use a heap there, right?", "Does that sound right to you?"
   - **The speaker thinking aloud.** "Can I add an opening bracket here?", "…how do I make sure that I remove it?"
   - **Very short lines** (under four words), which are mostly mishearings.
   - **The feedback part after an interview.** After "let me give you my feedback" or "I'm going to stop the timer", it stays quiet for 20 minutes.
5. **Queueing.** A question asked while an answer is still being written is answered straight after it. At most 6 automatic answers happen in any minute.

## Measured results

The recordings were public mock interviews: coding, system design, low-level design and one quant interview, with a range of accents and audio quality. Each one was split so the interviewer was the meeting audio and the candidate was the microphone, as in a real call with headphones.

| Set | Interviews | Audio | Requests | Per minute |
|---|---|---|---|---|
| Tuning set (the rules were adjusted on these) | 12 | 10.7 h | 186 (was 261 before tuning) | 0.29 |
| Held out, then used for one fix | 3 | 2.6 h | 50 | 0.32 |
| Fresh, then used for the last round | 5 | 4.9 h | 97 (was 104 before the last round) | 0.33 |
| **All** | **20** | **18.2 h** | **333** | **0.31**, about one every 3 minutes |

**By interview**, requests per minute ranged from **0.06** (a low-level design interview where the interviewer barely speaks) to **0.63** (a system design interview with a talkative interviewer and a long feedback section at the end).

**How many requests were worth it.** I read every answered question in the fresh set before the last round of tuning:
- about **70% were real questions** a candidate would want help with;
- about **30% were wasted**, mostly on the feedback section, check-ins and mishearings.

That's the best independent estimate available. Numbers for the tuning set look better, but that's partly because the rules were adjusted on it.

**Missed questions** weren't measured as carefully. There's no complete answer key for these recordings, so misses were found by reviewing what was skipped. The known kinds are listed below.

**Speed:** the panel opens as soon as a question is detected, and the answer usually starts within your wait setting plus your AI provider's time to first word.

## What it gets wrong

**Wasted requests (answers you didn't need):**
- **A feedback section with no clear cue.** It's only recognised after an explicit phrase like "let me give you my feedback". An interviewer who just drifts into feedback gets their rhetorical questions answered. This was the largest remaining source of waste.
- **Mishearings.** Whisper sometimes produces plausible-looking questions from unclear speech ("Have you ever had a good time?"). Anything four words or longer that looks like a question can be sent.
- **Prompts the candidate can answer alone,** like "Is that inclusive or exclusive?" or "What do you mean by that?". They're real questions, so they're answered.

**Missed questions:**
- **Very short prompts,** such as "What should happen?" or "Why zero?", are skipped by the four-word minimum. That's a deliberate trade: most lines that short are mishearings.
- **Questions Whisper transcribes as statements.** "Why a lock-free ring buffer instead of a queue?" came out as "while a lock-free ring buffer instead of a regular Q." with no "?" and no question word. A larger Whisper model helps.
- **Questions that sound rhetorical,** like "right?" and "correct?" endings, or first-person questions. In rare cases these are real.
- **Questions someone else answered first** are skipped on purpose. If you want help anyway, press the screenshot shortcut.

**Speakers:**
- **Two people are never merged into one voice** in any of the 20 interviews. That matters, because the "someone already answered" check depends on it.
- **One person is often split into several labels,** 3–8 per interview. Giving those labels the same name in **People** merges them.
- Some pairs of voices are almost indistinguishable to the speaker model. In one interview two different people scored 0.94 similarity. That's why labels are never merged automatically.

## Getting the most out of it

- **Use headphones.** Without them your mic hears the other side. Echo is filtered out, but some can slip through.
- **Pick a fast model** (GPT-4o-mini, Claude Haiku, Gemini Flash, Groq) so answers start quickly.
- **Use a larger Whisper model** (Small) if your Mac can run it live. Most remaining misses are transcription errors.
- **Turn auto-answer off** during small talk or when you don't need it: **⌘⇧U**, or the ❓ button.
- **Use a 2-second wait,** the default, for most conversations. Use 3 seconds for interviewers who ask long, multi-part questions.

## How to reproduce or extend these numbers

The replay tooling is in [`scripts/replay/`](../scripts/replay/README.md):
1. `make_scenarios.py` generates test meetings.
2. `batch.py` replays a folder of recordings end to end.
3. `replay-detector.ts` scores what auto-answer would do.
4. `npm run test:detector` checks 131 regression cases collected from these interviews, plus a wrap-up scenario.

Adding new recordings, especially behavioral interviews and meetings with three or more people, is the best way to find what these 20 didn't cover.
