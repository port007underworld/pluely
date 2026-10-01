/**
 * Evaluates the model check ("should auto-answer fire?") on a replayed
 * meeting: takes the questions the rules would answer (replay-detector with
 * DETECTOR_JSON=1), sends each to the real check with the conversation so far,
 * and scores both against the truth file. Makes real API calls (one small
 * request per question).
 *
 *   GATE_PROVIDER=provider.json GATE_API_KEY=… node eval-gate.mjs lines.json truth.json fired.json
 * provider.json: {"provider": {TYPE_PROVIDER}, "selection": {"provider": id, "variables": {...}}}
 */
import { readFileSync } from "node:fs";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, String(v)),
  removeItem: (k: string) => store.delete(k),
};
(globalThis as any).window = { dispatchEvent() {}, addEventListener() {}, localStorage: (globalThis as any).localStorage };

const { checkWithModel } = await import("./answer-gate");

interface Line { source: string; speaker?: string; start: number; end: number; arrives: number; text: string }
interface Truth { text: string; start: number; end: number; expect: "answer" | "skip" | null }

// The questions the rules would answer, from replay-detector (DETECTOR_JSON=1).
const [linesPath, truthPath, firedPath] = process.argv.slice(2);
const lines: Line[] = JSON.parse(readFileSync(linesPath, "utf8"));
const truth: Truth[] = truthPath && truthPath !== "-" ? JSON.parse(readFileSync(truthPath, "utf8")) : [];
const fired: { at: number; question: string }[] = JSON.parse(readFileSync(firedPath, "utf8")).fired;
const config = JSON.parse(readFileSync(process.env.GATE_PROVIDER!, "utf8"));
config.selection.variables.api_key = process.env.GATE_API_KEY;

// Keep the app's request logging out of the report.
const print = (...args: unknown[]) => process.stdout.write(args.join(" ") + "\n");
console.log = console.info = console.warn = console.error = () => {};

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const overlap = (a: string, b: string) => {
  const wa = words(a), wb = words(b);
  return [...wa].filter((w) => wb.has(w)).length / Math.max(1, Math.min(wa.size, wb.size));
};
const labelFor = (f: { at: number; question: string }) =>
  truth.find((t) => t.expect && overlap(t.text, f.question) >= 0.6 && f.at >= t.start && f.at <= t.end + 60)?.expect ?? null;

let calls = 0, failures = 0;
const rows: { at: number; question: string; label: string | null; answer: boolean | null; rewritten: string; reason: string; ms: number }[] = [];
for (const f of fired) {
  const context = lines
    .filter((l) => l.arrives <= f.at)
    .sort((a, b) => a.start - b.start)
    .slice(-10)
    .map((l) => ({ who: l.source === "mic" ? "You" : l.speaker ?? "Them", text: l.text }));
  const started = performance.now();
  const decision = await checkWithModel({ provider: config.provider, selectedProvider: config.selection, lines: context, timeoutMs: 8000 });
  calls++;
  if (!decision) failures++;
  rows.push({ at: f.at, question: f.question, label: labelFor(f), answer: decision?.answer ?? null, rewritten: decision?.question ?? "", reason: decision?.reason ?? "(no decision)", ms: Math.round(performance.now() - started) });
}

for (const r of rows) {
  const verdict = r.answer === null ? "??" : r.answer ? "YES" : "no ";
  print(`${verdict} [${r.label ?? "-"}] ${r.at.toFixed(0)}s ${r.question.slice(0, 80)}\n      → ${r.reason}${r.answer ? ` | ${r.rewritten.slice(0, 90)}` : ""} (${r.ms} ms)`);
}
const useful = truth.filter((t) => t.expect === "answer").length;
const keep = (r: (typeof rows)[number]) => r.answer !== false; // no decision → rules' verdict
const tp = (rs: typeof rows) => rs.filter((r) => r.label === "answer").length;
const before = rows, after = rows.filter(keep);
print(`\ncalls ${calls}, no decision ${failures}, median ${rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0} ms`);
if (truth.length) {
  print(`rules only:   ${before.length} requests, ${tp(before)} useful (${Math.round((100 * tp(before)) / Math.max(1, before.length))}%), answered ${tp(before)}/${useful} useful questions`);
  print(`rules + check: ${after.length} requests, ${tp(after)} useful (${Math.round((100 * tp(after)) / Math.max(1, after.length))}%), answered ${tp(after)}/${useful} useful questions`);
}
