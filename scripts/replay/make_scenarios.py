#!/usr/bin/env python3
"""Synthetic meeting recordings for the live-transcription replay test.

Each scenario is written as 16 kHz mono WAVs plus a ground-truth script:
  <out>/<name>.system.wav   what the computer plays (the meeting)
  <out>/<name>.mic.wav      the microphone (only some scenarios)
  <out>/<name>.truth.json   who said what, when, and whether it's a question
                            that auto-answer should take

Usage: python3 scripts/replay/make_scenarios.py <out-dir>   (macOS: uses `say`)
"""
import json, os, subprocess, sys, tempfile, wave
import numpy as np

RATE = 16_000
VOICES = {"Grace": ("Samantha", 185), "Nolan": ("Daniel", 180), "You": ("Rishi", 175), "Priya": ("Samantha", 180)}
rng = np.random.default_rng(7)


def speak(who, text, tmp):
    voice, rate = VOICES[who]
    aiff, wav = os.path.join(tmp, "s.aiff"), os.path.join(tmp, "s.wav")
    subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", aiff, text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, wav], check=True)
    with wave.open(wav) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def place(track, audio, at):
    end = int(at * RATE) + len(audio)
    if end > len(track):
        track = np.concatenate([track, np.zeros(end - len(track), np.float32)])
    track[int(at * RATE):end] += audio
    return track


def noise(seconds, level):
    return (rng.standard_normal(int(seconds * RATE)) * level).astype(np.float32)


def keyboard(seconds):
    """Bursts of clicks, like typing."""
    out = np.zeros(int(seconds * RATE), np.float32)
    t = 0.0
    while t < seconds - 0.1:
        click = rng.standard_normal(int(0.012 * RATE)).astype(np.float32) * np.exp(-np.linspace(0, 8, int(0.012 * RATE)))
        i = int(t * RATE)
        out[i:i + len(click)] += click * 0.25
        t += rng.uniform(0.08, 0.35) if rng.random() > 0.1 else rng.uniform(0.6, 1.5)
    return out


def tone_music(seconds):
    t = np.arange(int(seconds * RATE)) / RATE
    notes = [262, 330, 392, 523]
    return sum(0.05 * np.sin(2 * np.pi * f * t) * (np.sin(2 * np.pi * 0.5 * t + i) > 0) for i, f in enumerate(notes)).astype(np.float32)


def write(path, audio):
    audio = np.clip(audio, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((audio * 32767).astype(np.int16).tobytes())


def build(name, script, out, tmp, mic_script=None, echo_level=0.0, typing=None, background=0.0):
    """script: list of (who, text, gap_after_seconds, expect) where expect is
    "answer" (auto-answer should take it), "skip" or None (not a question).
    A negative gap overlaps the next line with this one."""
    system = np.zeros(0, np.float32)
    truth, t = [], 1.0
    for who, text, gap, expect in script:
        if who == "_music":
            audio = tone_music(float(text))
        elif who == "_silence":
            audio = np.zeros(int(float(text) * RATE), np.float32)
        else:
            audio = speak(who, text, tmp)
            truth.append({"who": who, "text": text, "start": round(t, 2), "end": round(t + len(audio) / RATE, 2), "expect": expect})
        system = place(system, audio, t)
        t += len(audio) / RATE + gap
    system = place(system, np.zeros(RATE), t)
    if background:
        system += noise(len(system) / RATE, background)[: len(system)]
    write(os.path.join(out, f"{name}.system.wav"), system)

    if mic_script:
        mic = np.zeros(len(system), np.float32)
        for who, text, at, _ in mic_script:
            audio = speak(who, text, tmp)
            truth.append({"who": who, "text": text, "start": round(at, 2), "end": round(at + len(audio) / RATE, 2), "expect": None, "mic": True})
            mic = place(mic, audio, at)
        if echo_level:
            delay = int(0.04 * RATE)
            mic = place(mic, system * echo_level, 0.04)[: len(mic)] if len(system) else mic
        if typing:
            for at, seconds in typing:
                mic = place(mic, keyboard(seconds), at)
        mic = mic[: len(system)] + noise(len(system) / RATE, 0.003)[: len(system)]
        write(os.path.join(out, f"{name}.mic.wav"), mic)

    truth.sort(key=lambda x: x["start"])
    json.dump(truth, open(os.path.join(out, f"{name}.truth.json"), "w"), indent=1)
    print(f"{name}: {len(system) / RATE:.0f}s, {len(truth)} lines")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "replay-out"
    os.makedirs(out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        # Both sides of an interview in the meeting audio (a recording, or the
        # candidate on the same call), with fast turn-taking.
        build("both-sides", [
            ("Grace", "Hey, my name is Grace, I'm calling from Jane Street. Is this Nolan?", 0.25, "skip"),
            ("Nolan", "Hey Grace, yeah, this is Nolan.", 0.4, None),
            ("Grace", "Awesome. Is now still a good time for you?", 0.2, "skip"),
            ("Nolan", "Yes, now is great.", 0.8, None),
            ("Grace", "Great. So, to start, can you tell me about a project you're proud of?", 0.6, "answer"),
            ("Nolan", "Sure. Last year I built a market data service that handled about two million messages a second. "
                      "The hardest part was keeping latency under a millisecond while we added new venues, "
                      "so we moved the parsing onto a lock free ring buffer and pinned the hot threads to their own cores.", 0.5, None),
            ("Grace", "Mm-hmm.", 0.3, None),
            ("Grace", "Interesting. Why a lock free ring buffer instead of a regular queue?", 2.5, "answer"),
            ("Nolan", "Mostly to avoid contention between the producer and the consumer.", 1.0, None),
            ("_music", "5", 0.5, None),
            ("Grace", "Okay, let's move to a coding question. Given an array of integers, return the length of the longest increasing subsequence.", 0.9, None),
            ("Grace", "What's the time complexity of your first approach?", 3.0, "answer"),
            ("Nolan", "The simple dynamic programming version is O of n squared.", 0.3, None),
            ("Grace", "Can you do better than that?", 3.0, "answer"),
            ("_silence", "15", 0, None),
            ("Grace", "Does that make sense?", 1.2, "skip"),
            ("Nolan", "Yes, that makes sense.", 0.5, None),
            ("Grace", "How would you test this under load, and what metrics would you watch?", 3.0, "answer"),
        ], out, tmp, background=0.004)

        # You on laptop speakers: the mic hears you, the interviewer's echo and typing.
        build("speakers-echo", [
            ("Priya", "Thanks for joining. Can you walk me through how you would design a rate limiter for our public API?", 9.0, "answer"),
            ("Priya", "Got it. And what happens if Redis goes down?", 8.0, "answer"),
            ("Priya", "Makes sense. How would you roll this out safely?", 9.0, "answer"),
        ], out, tmp, mic_script=[
            ("You", "I'd use a token bucket per API key, stored in Redis.", 9.2, None),
            ("You", "Then I'd fail open with a small local limit.", 17.5, None),
            ("You", "Behind a feature flag, starting with five percent of traffic.", 27.0, None),
        ], echo_level=0.18, typing=[(3.0, 4.0), (21.0, 3.0)])


if __name__ == "__main__":
    main()
