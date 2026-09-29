# Runningbord

AI assistant that integrates better with you.

**New here? Read the [User Guide](docs/USER_GUIDE.md)** for setup, every feature, keyboard shortcuts, privacy and troubleshooting, written for first-time users.

**Highlights:**
- Answers from a screenshot plus what was just said in the meeting, with one key press.
- Meeting transcription on your own computer (Whisper), with speaker names and talk time.
- Optional automatic answers to other people's questions, suggested follow-ups and quick rewrites.
- Pinned facts, meeting prep from an invite, meeting notes, and profiles per kind of meeting.
- Chats stored locally with full-text search, export and automatic deletion; API keys in the system keychain.
- Opt-in, signed updates. No analytics and no account.

**Supported platforms:** macOS (Apple Silicon and Intel) and Windows (x64). Linux is not supported.

## Meeting transcription

When **Meeting mode** is on (speaker icon in the overlay, or its shortcut), the screenshot shortcut also sends a transcript of the recent conversation. The AI can then answer what was just asked in the meeting, not only what's on screen.

- **Structured transcript.** Lines are timestamped ("[-1m20s]") and labelled by who spoke:
  - "Them" is the other participants (computer audio).
  - "You" is you (microphone, optional).
  - "Speaker 1", "Speaker 2"… appear when speaker separation is on.
- **Choose where transcription happens** (**Meeting** page):
  - **On this device** (default): Whisper runs locally. It's free and private. Pick a model from Tiny to Large v3 Turbo, and download it in-app.
  - **Cloud provider** (opt-in): uses the speech-to-text provider configured in Dev Space (Google, Groq, OpenAI, Deepgram, …). Audio is sent only when you press the shortcut.
  - **Raw audio** (advanced): attaches the audio file itself, for AI providers that accept audio (e.g. Gemini).
- **Live transcription.** With the local engine, speech is transcribed in the background as people talk. A shortcut press is near-instant and can include up to the last 10 minutes (default 5).
- **Your microphone** (optional). Your side of the conversation is transcribed separately. Speaker audio picked up by the mic is filtered out; headphones give the cleanest result.
- **Speaker separation** (macOS, optional): tells remote participants apart by voice with a small on-device model (26 MB). Numbering restarts each time Meeting mode is turned on.
- **Silence detection.** If no audio was captured (nothing playing, or permission missing), the overlay says so instead of sending silence.
- **Test it:** "Transcribe now" in the settings runs exactly what the shortcut does.

## Conversations and context

- **Reliable answers.** Each answer streams back on its own channel, and a new question cancels the previous request. Answers from overlapping requests can no longer mix, and stale answers can't show up after a newer question.
- **Nothing gets lost.** Messages are saved append-only, so quick follow-up questions can't overwrite earlier turns. Failed requests show an error instead of being saved as an answer.
- **Follow-ups keep context.** A screenshot question is saved together with the meeting transcript that was sent, so "what about the second part?" works.
- **Conversation memory** (Response Settings › Conversation Memory):
  - The overlay starts a new conversation after a configurable idle time (default 10 min), so one meeting doesn't bleed into the next.
  - Each question sends recent history within a token budget (default ~8k). The last exchange is always included, and repeated meeting transcripts are sent only once.
  - The overlay header shows how much context was sent.
- **New Conversation shortcut** (⌘⇧N / Ctrl+Shift+N) clears the AI's memory of the current chat at any time.
- **Chat history** loads quickly: the list reads only titles and counts, and messages load when you open a chat.

## Prompts tuned for technical work

The default prompts make the AI answer the one thing you need right now: the question just asked in the meeting, or the code, error or problem on screen. It leads with the answer (code, fix, or what to say) and ignores incidental details like browser tabs, notifications, file trees and meeting UI.

- **Built-in presets** (System Prompts page): **Coding Copilot** (default), **Technical Interview** (say-it-out-loud answers, complete code with complexity, system design and behavioral formats), **Debugging** (root cause, then the exact fix) and **Code Review** (real bugs and edge cases, no style nitpicks). Click one to use it, or **Customize** to make an editable copy.
- **Screenshot instructions** (**Screenshot** page, "Instructions sent with each screenshot"): what to do with each capture. It checks the latest question in the transcript first, then the main thing on screen. **Reset to default** restores it.
- If you never changed the old default prompts, you get the new ones automatically. Prompts you edited are kept.

## My Context

Give the AI background about yourself on the **My Context** page: upload your resume or a job description (PDF, TXT or Markdown), or write notes (your role, stack, projects you want to highlight). It's added to every request as reference material. The AI uses it only when it helps, for example answering "tell me about yourself" with your real experience or matching what the role asks for. It's told never to invent experience that isn't there.

- Each item has its own on/off switch, so you can keep several (e.g. job descriptions for different companies) and turn on only what fits today's interview or meeting.
- Files are read on your device and only the extracted text is kept. You can review and correct it. Scanned PDFs (images of text) aren't supported, so paste the text instead.
- Active context is capped at about 12k tokens and is added to every request, so keep it focused. The page shows the current size.

## Troubleshooting

- **Dev Space › Recent Requests** shows exactly what was sent for the last 25 questions: history, attachments, transcript, token estimate, timing and errors. It's stored only on your device and never includes API keys.
- **Settings › Permissions** shows whether Screen Recording and Microphone are granted, and can check that system audio is actually coming through. It has shortcuts to the right System Settings pages.
- If Meeting mode fails to start, the overlay's speaker button turns red and shows the reason.
- API keys are never written to the console or logs.

## Building

**Prerequisites**
- Node.js LTS and Rust stable (`rustup`).
- CMake (whisper.cpp is compiled from source).
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- Windows: Visual Studio Build Tools (C++).

**Commands**

```sh
npm ci                   # once, and after pulling dependency changes
npm run tauri dev        # run with hot reload
npm run tauri build      # installable build
```

`npm run tauri build` writes the app to `src-tauri/target/release/bundle/` (`macos/Runningbord.app` and `dmg/` on macOS). The first build takes several minutes: it compiles whisper.cpp and, on macOS, downloads about 200 MB of speech libraries (cached afterwards).

## macOS: signing and permissions

The app needs **Screen Recording** (screenshots), **System Audio Recording** (meeting audio, macOS 14.2+) and optionally **Microphone**.

**Builds are signed automatically.** macOS ties those permissions to the app's code signature. An unsigned build gets a new signature every time, so permissions can look enabled in System Settings but stop working. To prevent that, `npm run tauri build` always signs macOS builds with the same self-signed certificate, "Runningbord Dev". No paid Apple account is needed and there is nothing to configure:
- The first build creates the certificate in your login keychain. It also keeps a copy plus the CI secrets in `~/.runningbord-signing/` (private; don't commit or share).
- Every later build is signed with it, and the build log ends with the signature it used.
- `RUNNINGBORD_UNSIGNED=1 npm run tauri build` skips signing once. `APPLE_SIGNING_IDENTITY="..."` uses a different identity.
- Keep that certificate. If it's deleted, a new one is created and permissions have to be granted once more.

**Dev mode isn't signed, and doesn't need to be.** With `npm run tauri dev`, macOS gives the permissions to the terminal or IDE you launched it from (Terminal, iTerm, VS Code…). Grant them to that app once and they persist across rebuilds.

**Releases from CI.** Add the three values from `~/.runningbord-signing/secrets.txt` as GitHub repository secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`). The publish workflow then signs macOS releases with the same certificate as your local builds, so users keep their permissions across updates. Without the secrets, CI builds are unsigned (ad-hoc).

**First launch of a downloaded build.** Builds are signed but not notarized, so macOS blocks the first launch. Right-click the app and choose **Open**, or allow it under System Settings › Privacy & Security. Alternatively:

```sh
xattr -dr com.apple.quarantine /Applications/Runningbord.app
```

**Permissions still not working?** Settings › Permissions in the app shows what's granted. To clear stale grants, for example after installing a build signed differently:

```sh
tccutil reset ScreenCapture com.srikanthnani.runningbord
tccutil reset Microphone com.srikanthnani.runningbord
tccutil reset AudioCapture com.srikanthnani.runningbord
```
