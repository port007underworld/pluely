#!/usr/bin/env python3
"""Replay a folder of recorded interviews and summarise what the app does.

For each recording (mp3/m4a/wav) in <samples>:
  1. convert to 16 kHz mono
  2. replay the whole recording (speaker labels)
  3. group the voices into two people offline (k-means over the whole
     recording's voice embeddings; independent of the app's live labels, so
     auto-answer is judged on a correct split), pick the interviewer (asks
     the most questions per minute of talk) and split: interviewer on the
     meeting audio, the other person on the mic
  4. replay the split, as the app would hear a real call with headphones
  5. run the auto-answer detector on the interviewer's lines
Outputs go to <samples>/.replay/<id>.*, and a report to <samples>/.replay/report.md.
Steps whose output already exists are skipped, so it can be re-run.

  python3 scripts/replay/batch.py ~/Downloads/runningbord-samples [--jobs 2] [--only id,...]
"""
import argparse, concurrent.futures as cf, json, os, re, subprocess, sys
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TAURI = os.path.join(ROOT, "src-tauri")


def slug(name):
    m = re.search(r"\[([A-Za-z0-9_-]{6,})\]", name)
    return m.group(1) if m else re.sub(r"[^A-Za-z0-9]+", "-", os.path.splitext(name)[0])[:40]


def run(cmd, env=None, **kw):
    return subprocess.run(cmd, env={**os.environ, **(env or {})}, check=True, **kw)


def replay(system, out, mic=None, emb=None):
    env = {"REPLAY_SYSTEM": system, "REPLAY_OUT": out}
    if mic: env["REPLAY_MIC"] = mic
    if emb: env["REPLAY_EMBEDDINGS"] = emb
    run(["cargo", "test", "--quiet", "replay_recording", "--", "--ignored"], env=env, cwd=TAURI,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def roles(lines):
    """Interviewer = the person who talks clearly less (candidates think aloud,
    and in design interviews ask plenty of questions); if talk is close, the
    one asking more questions per minute."""
    talk, questions = Counter(), Counter()
    for l in lines:
        k = l.get("speaker") or "Them"
        talk[k] += l["end"] - l["start"]
        questions[k] += l["text"].count("?")
    main = [k for k in talk if k != "Them" and talk[k] >= 60] or [k for k in talk if k != "Them"]
    by_talk = sorted(main, key=talk.get)
    if len(by_talk) >= 2 and talk[by_talk[1]] >= 1.3 * talk[by_talk[0]]:
        interviewer = by_talk[0]
    else:
        interviewer = max(main, key=lambda k: questions[k] / max(talk[k], 1))
    you = [k for k in main if k != interviewer]
    return interviewer, you, talk, questions


def people(lines, emb_path):
    """Label each line P0/P1 by clustering the recording's voice embeddings
    into two people, and return the lines relabelled."""
    import numpy as np
    from sklearn.cluster import KMeans
    E = json.load(open(emb_path))
    T = np.array([(a, b) for a, b, _ in E])
    X = np.array([e for *_, e in E], dtype=np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    reliable = (T[:, 1] - T[:, 0]) >= 1.5
    km = KMeans(2, n_init=20, random_state=0).fit(X[reliable])
    c = km.cluster_centers_ / np.linalg.norm(km.cluster_centers_, axis=1, keepdims=True)
    ref = (X @ c.T).argmax(1)
    out = []
    for l in lines:
        if l["source"] != "system":
            continue
        overlap = np.minimum(T[:, 1], l["end"]) - np.maximum(T[:, 0], l["start"])
        votes = np.bincount(ref[overlap > 0], weights=overlap[overlap > 0], minlength=2)
        who = int(votes.argmax()) if votes.sum() > 0 else int(ref[np.argmin(np.abs(T[:, 0] - l["start"]))])
        out.append({**l, "speaker": f"P{who}"})
    return out


def process(path, work, detector):
    name = os.path.basename(path)
    sid = slug(name)
    base = os.path.join(work, sid)
    log = lambda msg: print(f"[{sid}] {msg}", flush=True)
    if not os.path.exists(base + ".wav"):
        run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", base + ".wav"])
    if not os.path.exists(base + ".lines.json"):
        log("transcribing whole recording")
        replay(base + ".wav", base + ".lines.json", emb=base + ".emb.json")
    lines = json.load(open(base + ".lines.json"))
    live_talk = Counter()
    for l in lines:
        live_talk[l.get("speaker") or "Them"] += l["end"] - l["start"]
    if not os.path.exists(base + ".people.json"):
        json.dump(people(lines, base + ".emb.json"), open(base + ".people.json", "w"))
    two = json.load(open(base + ".people.json"))
    interviewer, you, talk, questions = roles(two)
    if not os.path.exists(base + ".split2.lines.json"):
        log(f"interviewer {interviewer}, you {you}; replaying split")
        run([sys.executable, os.path.join(ROOT, "scripts/replay/split_by_speaker.py"), base + ".wav", base + ".people.json",
             base + ".split2", "--you", ",".join(you) or "none"], stdout=subprocess.DEVNULL)
        replay(base + ".split2.system.wav", base + ".split2.lines.json", mic=base + ".split2.mic.wav")
    decisions = json.loads(subprocess.run(["node", detector, base + ".split2.lines.json", "-", "2000"], env={**os.environ, "DETECTOR_JSON": "1"},
                                          check=True, capture_output=True, text=True).stdout)
    json.dump(decisions, open(base + ".decisions.json", "w"), indent=1)
    log(f"done: {len(decisions['fired'])} answered, {len(decisions['skipped'])} skipped")
    return {"id": sid, "name": name, "minutes": max((l["end"] for l in lines), default=0) / 60,
            "labels": {k: round(v / 60, 1) for k, v in live_talk.most_common()}, "questions": dict(questions),
            "interviewer": interviewer, "you": you, "answered": len(decisions["fired"]),
            "skipped": Counter(s["reason"] for s in decisions["skipped"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples"); ap.add_argument("--jobs", type=int, default=2); ap.add_argument("--only")
    args = ap.parse_args()
    work = os.path.join(args.samples, ".replay")
    os.makedirs(work, exist_ok=True)
    detector = os.path.join(work, "replay-detector.cjs")
    run(["npx", "esbuild", os.path.join(ROOT, "scripts/replay/replay-detector.ts"), "--bundle", "--platform=node",
         "--alias:@=./src", "--log-level=error", f"--outfile={detector}"], cwd=ROOT)
    run(["cargo", "test", "--quiet", "--no-run"], cwd=TAURI, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    files = sorted(f for f in os.listdir(args.samples) if f.lower().endswith((".mp3", ".m4a", ".wav")))
    if args.only:
        wanted = set(args.only.split(","))
        files = [f for f in files if slug(f) in wanted]
    with cf.ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(lambda f: process(os.path.join(args.samples, f), work, detector), files))
    with open(os.path.join(work, "report.md"), "w") as out:
        out.write("| id | min | live speaker labels (min of talk) | interviewer | answered | skipped |\n|---|---|---|---|---|---|\n")
        for r in results:
            labels = ", ".join(f"{k} {v}" for k, v in r["labels"].items())
            skipped = ", ".join(f"{k} {v}" for k, v in r["skipped"].items()) or "0"
            out.write(f"| {r['id']} | {r['minutes']:.0f} | {labels} | {r['interviewer']} | {r['answered']} | {skipped} |\n")
    print(open(os.path.join(work, "report.md")).read())


if __name__ == "__main__":
    main()
