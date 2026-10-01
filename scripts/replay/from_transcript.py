#!/usr/bin/env python3
"""Turn a scripted interview (JSONL) into replay audio and an answer key.

Input lines look like:
  {"id": 1, "speaker": "INT"|"CAN", "text": "...", "pause_after_s": 0.6,
   "label": {"ai_answer_useful": true, "why": "..."}}
The interviewer (INT) becomes the meeting audio, the candidate (CAN) the mic,
as in a real call with headphones. Labels on INT lines become the truth file
read by replay-detector.ts: "answer" when ai_answer_useful, else "skip".

  python3 scripts/replay/from_transcript.py interview.jsonl <out-prefix>
Writes <out-prefix>.system.wav, <out-prefix>.mic.wav, <out-prefix>.truth.json.
"""
import json, os, subprocess, sys, tempfile, wave
import numpy as np

RATE = 16_000
VOICES = {"INT": ("Samantha", 180), "CAN": ("Daniel", 180)}


def speak(voice, rate, text, tmp):
    aiff, wav = os.path.join(tmp, "s.aiff"), os.path.join(tmp, "s.wav")
    subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", aiff, text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, wav], check=True)
    with wave.open(wav) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def write(path, audio):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


def main():
    src, out = sys.argv[1], sys.argv[2]
    rows = [json.loads(l) for l in open(src) if l.strip()]
    utterances = [r for r in rows if "speaker" in r]
    tracks = {"INT": [], "CAN": []}
    truth, t = [], 1.0
    with tempfile.TemporaryDirectory() as tmp:
        for i, r in enumerate(utterances):
            voice, rate = VOICES[r["speaker"]]
            audio = speak(voice, rate, r["text"], tmp)
            tracks[r["speaker"]].append((t, audio))
            label = r.get("label") or {}
            truth.append({
                "id": r.get("id", i + 1), "who": r["speaker"], "text": r["text"],
                "start": round(t, 2), "end": round(t + len(audio) / RATE, 2),
                "expect": None if r["speaker"] != "INT" else ("answer" if label.get("ai_answer_useful") else "skip"),
                "why": label.get("why"), "mic": r["speaker"] == "CAN",
            })
            # A negative pause overlaps the next utterance with this one.
            t += len(audio) / RATE + float(r.get("pause_after_s", 0.5))
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(utterances)} utterances", flush=True)
    total = int((t + 2) * RATE)
    for speaker, name in (("INT", "system"), ("CAN", "mic")):
        track = np.zeros(total, np.float32)
        for at, audio in tracks[speaker]:
            i = int(at * RATE)
            track[i:i + len(audio)] += audio[: total - i]
        # A little room noise, like a real call.
        track += np.random.default_rng(3).standard_normal(total).astype(np.float32) * 0.002
        write(f"{out}.{name}.wav", track)
    json.dump(truth, open(f"{out}.truth.json", "w"), indent=1)
    print(f"{len(utterances)} utterances, {t / 60:.1f} min; wrote {out}.system.wav, {out}.mic.wav, {out}.truth.json")


if __name__ == "__main__":
    main()
