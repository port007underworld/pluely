# Replay testing for live transcription and auto-answer

Some problems only show up with real speech: people replying within half a
second, echo from laptop speakers, Whisper mishearing a word or dropping a
"?". This kit replays recordings through the real pipeline, on a simulated
clock, and scores auto-answer against what was actually said.

1. **Make recordings** (macOS; uses `say`). Scenarios are defined in the
   script; add more there.

       python3 scripts/replay/make_scenarios.py /tmp/replay

   Each scenario writes `<name>.system.wav` (the meeting audio),
   optionally `<name>.mic.wav`, and `<name>.truth.json` (who said what,
   when, and which questions auto-answer should take).

2. **Transcribe them** with the live transcriber: speech detection,
   Whisper, per-sentence speaker labels, echo filtering and noise filters.

       cd src-tauri
       REPLAY_SYSTEM=/tmp/replay/both-sides.system.wav \
       REPLAY_OUT=/tmp/replay/both-sides.lines.json \
         cargo test replay_recording -- --ignored --nocapture

   Add `REPLAY_MIC=…mic.wav` for scenarios with a microphone. Uses the app's
   downloaded Whisper and speaker models (`REPLAY_MODEL` to override). You
   can also replay a real recording: convert it to 16 kHz mono first,
   e.g. `afconvert -f WAVE -d LEI16@16000 -c 1 in.m4a out.wav`.

3. **Score auto-answer** on those lines (optionally with a wait in ms):

       npx esbuild scripts/replay/replay-detector.ts --bundle --platform=node \
         --alias:@=./src --outfile=/tmp/replay-detector.cjs
       node /tmp/replay-detector.cjs /tmp/replay/both-sides.lines.json \
         /tmp/replay/both-sides.truth.json 2000
