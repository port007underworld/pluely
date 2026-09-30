#!/usr/bin/env python3
"""Turn a two-person recording into a meeting track and a microphone track.

A recording of a call (say, a mock interview) has both people in one track.
In a real meeting the app hears the other person on the computer's audio and
you on the microphone. This splits the recording that way, using the speaker
labels from a replay of the whole file:

  python3 scripts/replay/split_by_speaker.py <recording.wav> <lines.json> <out-prefix> \
      [--you "Speaker 2"] [--echo 0.15]

--you    the label(s) to treat as you, comma-separated when one person got
         several labels (default: the main voice other than the one asking
         the most questions, i.e. the interviewee)
--echo   how much of the other person leaks into the mic, as with laptop
         speakers (0 = headphones)

Writes <out-prefix>.system.wav and <out-prefix>.mic.wav (16 kHz mono).
"""
import argparse, json, wave
from collections import defaultdict
import numpy as np

RATE = 16_000


def read(path):
    with wave.open(path) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono 16-bit"
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def write(path, audio):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recording"); ap.add_argument("lines"); ap.add_argument("out")
    ap.add_argument("--you"); ap.add_argument("--echo", type=float, default=0.0)
    args = ap.parse_args()

    audio = read(args.recording)
    lines = [l for l in json.load(open(args.lines)) if l["source"] == "system"]
    talk, questions = defaultdict(float), defaultdict(int)
    for l in lines:
        label = l.get("speaker") or "Them"
        talk[label] += l["end"] - l["start"]
        questions[label] += l["text"].count("?")
    print("talk time by label:", {k: round(v, 1) for k, v in sorted(talk.items(), key=lambda kv: -kv[1])})
    print("questions by label:", dict(questions))
    interviewer = max(talk, key=lambda k: (questions[k], talk[k]))
    others = [k for k in talk if k != interviewer] or [interviewer]
    you = set(args.you.split(",")) if args.you else {max(others, key=talk.get)}
    print(f"treating {sorted(you)} as you")

    # Replay times are seconds from the start of the recording; the replay
    # starts feeding audio at 0, so they line up with sample positions.
    mask = np.zeros(len(audio), bool)
    for l in lines:
        if (l.get("speaker") or "Them") in you:
            a, b = int(max(0, l["start"] - 0.15) * RATE), int(min(len(audio) / RATE, l["end"] + 0.15) * RATE)
            mask[a:b] = True
    mic = np.where(mask, audio, 0).astype(np.float32)
    system = np.where(mask, 0, audio).astype(np.float32)
    if args.echo:
        delay = int(0.04 * RATE)
        mic[delay:] += system[:-delay] * args.echo
    mic += np.random.default_rng(1).standard_normal(len(mic)).astype(np.float32) * 0.002
    write(f"{args.out}.system.wav", system)
    write(f"{args.out}.mic.wav", mic)
    print(f"wrote {args.out}.system.wav and {args.out}.mic.wav ({mask.mean():.0%} of the audio is you)")


if __name__ == "__main__":
    main()
