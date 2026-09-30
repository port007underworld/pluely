/**
 * Feeds the lines from the replay test into the auto-answer question detector
 * on a simulated clock, and scores what it would answer against the truth
 * file written by make_scenarios.py.
 *
 *   npx esbuild scripts/replay/replay-detector.ts --bundle --platform=node \
 *     --alias:@=./src --outfile=/tmp/replay-detector.cjs
 *   node /tmp/replay-detector.cjs <lines.json> <truth.json> [pauseMs]
 */
import { readFileSync } from "node:fs";
import { createQuestionDetector } from "@/lib/functions/question-detect.function";

interface Line { source: string; speaker?: string; start: number; end: number; arrives: number; text: string }
interface Truth { who: string; text: string; start: number; end: number; expect: "answer" | "skip" | null; mic?: boolean }

const [linesPath, truthPath, pauseArg] = process.argv.slice(2);
const lines: Line[] = JSON.parse(readFileSync(linesPath, "utf8"));
const truth: Truth[] = JSON.parse(readFileSync(truthPath, "utf8"));
const pauseMs = Number(pauseArg ?? 2000);

// A tiny virtual clock: Date.now and setTimeout driven by the replay.
let now = 0;
const timers: { at: number; fn: () => void; id: number }[] = [];
let nextId = 1;
(globalThis as any).setTimeout = (fn: () => void, ms = 0) => {
  const id = nextId++;
  timers.push({ at: now + ms, fn, id });
  return id;
};
(globalThis as any).clearTimeout = (id: number) => {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
};
Date.now = () => now;
const advanceTo = (t: number) => {
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > t) break;
    timers.shift();
    now = next.at;
    next.fn();
  }
  now = t;
};

const fired: { at: number; question: string }[] = [];
const skipped: { at: number; question: string; reason: string }[] = [];
const detector = createQuestionDetector({
  onQuestion: (question) => fired.push({ at: now / 1000, question }),
  onSkip: (question, reason) => skipped.push({ at: now / 1000, question, reason }),
  pauseMs,
});

const events = lines
  .filter((l) => l.source === "system")
  .map((l) => ({ at: l.arrives * 1000, line: l }))
  .sort((a, b) => a.at - b.at);
for (const { at, line } of events) {
  advanceTo(at);
  detector.line(line.text, line.end * 1000, line.speaker ?? undefined);
}
advanceTo(now + 60_000);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const overlap = (a: string, b: string) => {
  const wa = words(a), wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size));
};
const matches = (t: Truth, text: string) => overlap(t.text, text) >= 0.6;

let problems = 0;
console.log(`pause ${pauseMs} ms\n`);
for (const t of truth.filter((t) => !t.mic && t.expect)) {
  const hit = fired.find((f) => matches(t, f.question));
  const ok = t.expect === "answer" ? Boolean(hit) : !hit;
  if (!ok) problems++;
  const when = hit ? ` (answered at ${hit.at.toFixed(1)}s, ${(hit.at - t.end).toFixed(1)}s after they stopped)` : "";
  console.log(`${ok ? "ok  " : "FAIL"} expect ${t.expect.padEnd(6)} ${t.text}${when}`);
}
for (const f of fired) {
  if (!truth.some((t) => t.expect === "answer" && matches(t, f.question))) {
    problems++;
    console.log(`FAIL unexpected answer at ${f.at.toFixed(1)}s: ${f.question}`);
  }
}
console.log(`\nskipped: ${skipped.map((s) => `[${s.reason}] ${s.question.slice(0, 60)}`).join("\n         ") || "none"}`);
console.log(`\n${problems} problem(s)`);
