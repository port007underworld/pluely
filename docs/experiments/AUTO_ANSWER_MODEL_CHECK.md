# Experiment: an AI check before automatic answers

**Status: tried, not shipped.** The code lives in `scripts/replay/experiments/` and isn't part of the app.

## The idea

Auto-answer decides whether a line is worth answering with hand-written rules (see [AUTO_ANSWER.md](../AUTO_ANSWER.md)). Each round of testing turned up new phrasings the rules missed, so we tried an AI judge, the same pattern as Claude Code's auto mode:

1. **The rules stay first** and decide the obvious cases instantly.
2. **The judge sees the rest.** Every line the rules would answer goes to the user's **fast model** with:
   - a short, fixed policy: should the assistant draft an answer now?
   - the last 10 lines of the conversation, from both sides.
3. **The judge replies** with JSON: `{answer, question, reason}`. `question` is the line rewritten as a standalone question.
4. **If it fails or takes longer than the timeout,** the rules' verdict stands.

The policy describes the *principle*, not the rules' patterns. Answer only when another participant asks the user something the user would benefit from having drafted now; not for small talk, logistics, check-ins, rhetorical questions or feedback, questions only the user can answer about themselves, things already answered, or transcription garbage.

## How it was tested

- **Model:** `gemini-3.5-flash-lite`, the fast model configured in the app, called through the app's own request code with a lean prompt: no personal context, pinned facts or formatting rules.
- **Inputs:** the questions the current rules would answer in three replayed interviews (see [scripts/replay/README.md](../../scripts/replay/README.md)):
  - a generated one-hour coding interview with a full answer key, written by a separate agent with no knowledge of the rules;
  - two real recorded interviews with the most wasted requests: a long system-design interview with a feedback section, and a coding interview.
- **Cost:** 102 small requests in total, a fraction of a cent.

## Results

| Interview | Rules would answer | Check vetoed | Effect |
|---|---|---|---|
| Generated coding interview (answer key) | 40 (37 useful, 93%) | 0 | No change: still 37 of 40 useful questions, 93% useful |
| Real system design, long feedback section | 51 | 6 | Removed garbled lines ("What is the sudden sign?"), a level check ("are you L4? L5?"), two rhetorical feedback lines |
| Real coding interview | 11 | 1 | Removed the interviewer answering their own question |

- **Latency:** about 1 second per check (median 0.98 s, range 0.7–1.6 s), added before every automatic answer.
- **Reliability:** no failed calls in 102.

## Why it wasn't shipped

1. **Little gain:** it vetoed about 10% of requests on messy real audio and nothing on clean audio. The rules plus the [split-sentence fix](../AUTO_ANSWER.md) already reach 93% useful requests on the generated interview.
2. **It missed the biggest waste:** the interviewer's rhetorical questions while giving feedback ("Why do I need reliability?", "What kind of monitoring do you mean?") got through. From 10 lines it can't tell the interview has moved into feedback.
3. **It invents questions from garbled lines,** so its rewrite can't be trusted:
   - "Can you take off?" became "Can you think of cases where it is not as easy?";
   - "Who is this used initial?" became "What do we need to define a recursive binary search?".
4. **Every automatic answer would start about 1 second later.**
5. **It was too lenient on clear cases:** it answered "What questions do you have for me?" and "the one-minute version of your background" despite the policy.

## If we try again

- **A sharper judge model,** such as the slow model or a stronger fast one. It should be more accurate, but slower; that's the main trade-off to measure.
- **More context:** a running note of the meeting's phase (intro, problem, coding, feedback) instead of only the last 10 lines. That's what's needed to catch feedback sections.
- **Veto only.** Never send the rewritten question; use the transcript as today.
- **Check only the uncertain cases,** not every fired question, to save time on clear ones.
- **Or train a small local classifier** for the same decision. The app already ships the runtime the speaker model uses, so a ~25 MB text model would add no network delay and work offline. LLM-generated labelled transcripts, plus the labelled lines from these tests, would be the training data.

## Re-running it

Everything stays on your machine except the small check requests to your own AI provider.

```sh
# 1. The questions the rules would answer (no API calls)
npx esbuild scripts/replay/replay-detector.ts --bundle --platform=node --alias:@=./src --outfile=/tmp/replay-detector.cjs
DETECTOR_JSON=1 node /tmp/replay-detector.cjs <lines.json> - 2000 > /tmp/fired.json

# 2. The check on each (real API calls)
npx esbuild scripts/replay/experiments/eval-gate.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/eval-gate.mjs
GATE_PROVIDER=<provider.json> GATE_API_KEY=<key> node /tmp/eval-gate.mjs <lines.json> <truth.json or -> /tmp/fired.json
```

`provider.json` is `{"provider": <the provider entry as stored by the app>, "selection": {"provider": <id>, "variables": {"model": <fast model>}}}`.

- **Lines** come from the replay test (`<id>.split2.lines.json` from `batch.py`, or `interview.lines.json` from `from_transcript.py`).
- **Truth files** come from `make_scenarios.py` or `from_transcript.py`.
- **Without a truth file,** the script lists each decision with its reason, to review by hand.
