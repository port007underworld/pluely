# Production readiness plan: conversations, context, meeting audio, macOS permissions

Written 2026-09-28. Line refs are against `master` @ `be87f17` plus the uncommitted `ai-response.function.ts` logging diff.

## Progress (2026-09-28, uncommitted)

**Done:**
- **P0.7** API-key debug log removed. Variables are now substituted into the template *before* user/history text is inserted.
- **P0.4** Request failures throw instead of streaming error text, so errors are no longer saved as assistant turns.
- **P0.3** Screenshot auto-submit now passes `signal`.
- **P0.6** `captured-selection` listener subscribes once, in both hooks.
- **New bug, fixed:** `Input.tsx` and `MessageHistory.tsx` sorted `conversationHistory` **in place**. Opening the history popover or conversation mode flipped React state to newest-first, so the next request sent history backwards.
- **P1.1 (partial)** Screenshot turns now store the prompt plus transcript that were actually sent, so follow-ups keep the context.
- **P2.1 (on-demand)** Local Whisper (`src-tauri/src/local_stt.rs`, whisper-rs 0.16, Metal on macOS):
  - Model download manager with progress and cancel.
  - Transcription reads straight from the ring buffer.
  - Buffers that are over 97% silent are skipped, which avoids hallucinated text and flags missing-permission zeros.
  - Cloud STT (opt-in) and raw audio remain as alternatives (`src/lib/functions/meeting-audio.function.ts`).
  - Verified: tiny.en transcribed JFK's 11 s speech in about 0.5 s (release build, M-series).
- **P2.2** Mic capture (`src-tauri/src/mic_audio.rs`, cpal, all platforms). Transcribed separately and labelled You/Them, with echo removal (time overlap plus word Jaccard ≥ 0.5).
- **P2.3 (partial)** Silence warnings are shown in the overlay. A `bufferSeconds` change now applies while capture is running.
- **Settings UI:** Screenshot & Audio › Meeting Transcription. Engine picker, model manager, language, mic toggle, "Transcribe now" test.

- **P0.1** Hosted API streams over a per-request Tauri `Channel`, not global events, so chunks can't cross between requests. Streaming is real (no longer await-then-dump). `chat_stream_cancel` aborts the HTTP request in Rust when the JS side aborts or stops consuming. `[DONE]` now exits the read loop.
- **P0.2** Hosted history is no longer reversed. Audio is forwarded and labelled `audio/ogg`. Unverified: whether the hosted backend accepts `{"type":"audio"}` parts (backend code isn't in this repo).
- **P0.5** Save race fixed:
  - `appendMessages` does an append-only upsert (`INSERT OR IGNORE`, title fixed at creation), serialized per conversation. The delete+reinsert `create/update/saveConversation` are removed.
  - The overlay keeps history in refs, updated **before** the DB write.
  - Switching or starting a conversation cancels the in-flight answer.
  - SQL verified with sqlite3 against the migration schema.
- **P4 (partial)** One request id from the hook through `fetchAIResponse`, the network-failure logs and Rust.
- **Titles** use the first line only, capped at 80 chars.

- **Live transcription** (`src-tauri/src/live_transcript.rs`):
  - A background worker runs an energy VAD: an utterance ends after 0.7 s of silence, is capped at 20 s, and anything under 0.3 s is dropped.
  - Utterances are transcribed as they finish, and segments are stored with wall-clock times for 15 min.
  - A shortcut press reads the chosen window (30 s to 10 min, default 5 min) plus a provisional transcription of the utterance still in progress.
  - Unit tests cover segmentation. A real-speech test (JFK) produced a correct chunk, transcribed in 135 ms with tiny.en.
- **P0.8** The overlay starts a new conversation after N min idle (default 10, configurable). There's also a **New Conversation** global shortcut (⌘⇧N) and an idle-reset notice.
- **P1.2** `buildBudgetedHistory` is shared by both hooks:
  - Token budget (default ~8k) that always keeps the last exchange and always starts with a user message.
  - "Earlier messages omitted" note when truncated.
  - Only the newest meeting transcript is kept verbatim in history.
  - Overlay header shows what was sent.
  - Settings: Response Settings › Conversation Memory.
- **P1.4** The history list loads metadata plus counts only (`listConversations`). Opening a chat no longer loads every conversation. Downloads fetch the full conversation on demand.
- **P2.3** System-audio start failures are shown on the overlay audio button and in the transcription settings.
- **P4** Every request (ok, error or cancelled) is recorded in a local request log. Dev Space › Recent Requests shows history shape, token estimate, attachments, transcript, timing and prompt preview.
- **P3** macOS permissions and signing:
  - `Info.plist` renamed so Tauri merges it (verified in a built bundle), with updated usage strings.
  - `entitlements.plist` plus hardened runtime. Verified in a signed build: runtime flag, audio-input entitlement, and a designated requirement pinned to the certificate leaf.
  - `scripts/macos-signing-cert.sh` creates the self-signed identity (tested in a throwaway keychain). No trust step is needed.
  - Optional CI signing step in `publish.yml`.
  - README section.
  - Settings › Permissions panel with status, grant, deep links and a system-audio check.
  - One shared `ensureScreenRecordingPermission` replaces the copies in both hooks.

- **Speaker separation** (`src-tauri/src/speaker_id.rs`, macOS only):
  - Each live system-audio utterance gets a WeSpeaker ResNet34 voice embedding (sherpa-onnx, statically linked, 26 MB model downloaded on demand).
  - Online clustering assigns "Speaker N": cosine ≥ 0.75 to join a speaker; utterances under 1.5 s only join a clear match (≥ 0.65) and never create speakers; max 8.
  - Voices reset when capture restarts.
  - Measured: same voice 0.93–0.94, different voices 0.40–0.67. The real-voice test labels A/B/A/C/B correctly.
  - Windows/Linux report "unsupported" (keeps the native dependency out of those CI builds).
  - Limit: one utterance with two people talking over each other gets one label.

**Not done:**
- P1.3 (merge the two hooks into one engine) is not done. The shared pieces (history builder, append-only saves, meeting audio) now live in `src/lib`, so what remains is a structural refactor with no behaviour change.
- Rolling LLM summary of dropped history: not done (costs an extra model call per conversation). The token budget plus transcript de-duplication covers the practical cases.

## TL;DR: why it feels sloppy

The symptoms you reported (stale answers, lost context, meeting audio not landing) come from about 15 concrete bugs, not one design flaw. The worst ones:

1. **Hosted (Runningbord API) streams are not correlated to requests.** Every request listens on the global `chat_stream_chunk` event. If you press the hotkey twice, request B receives A's chunks. Cancelling doesn't stop the Rust request either. This alone explains most of the "stale response" reports.
2. **Hosted path sends history in reverse order** (newest first) and **drops the audio entirely**.
3. **The overlay conversation never ends.** Every hotkey press in an app session gets appended to one conversation. That conversation is resent in full, and each stored user turn is just the auto-prompt text ("answer the question on screen") with no screen or audio content. So the model sees N identical questions with N different answers and anchors on the old ones.
4. **Error strings are saved as assistant messages** and resent as context on later turns.
5. **Save race.** The response shows before the DB save finishes. A quick next hotkey press uses history that's missing the last turn, then overwrites the DB (delete + reinsert) and drops that turn permanently.
6. **Meeting audio only captures system output, never the mic.** Providers without `{{AUDIO}}` in their curl template make the hotkey **throw** instead of falling back to a transcript. An unsigned macOS build can also silently capture silence.

---

## P0: correctness bugs (stale / wrong / lost data). Do first.

### P0.1 Correlate, cancel and actually stream hosted-API responses
- `src/lib/functions/ai-response.function.ts:140-164`: the listener is on the global `chat_stream_chunk` / `chat_stream_complete` events, and `await invoke(...)` only resolves **after the whole stream ends**. So there is no real streaming, and chunks from overlapping requests mix together.
- `src-tauri/src/api.rs:705,738`: events carry no request id. There is no way to cancel. `[DONE]` at `:680` only breaks the inner `for`, not the outer `while`.
- **Fix:** pass a `requestId` into `chat_stream_response` and emit `{requestId, chunk}` payloads, then filter on the JS side. Don't await the invoke before consuming. Keep a `HashMap<requestId, AbortHandle>` in Rust plus a `chat_stream_cancel(requestId)` command that the JS `signal` calls. Fix the `[DONE]` loop exit.
- **Done when:** spamming the hotkey 5× shows only the last request's text, with no interleaving, and cancelled requests stop network activity.

### P0.2 Hosted path: history order + audio
- `ai-response.function.ts:123`: `[...history].reverse()` is sent as-is by Rust (`api.rs:517-521`), so the model reads the conversation backwards. Remove the reverse.
- `ai-response.function.ts:253-259`: `audioBase64` is never forwarded to `fetchRunningbordAIResponse`.
- `api.rs:560-566`: audio is labelled `audio/wav`, but it is OGG/Opus, and `{"type":"audio"}` is not an OpenAI-compatible content part. Either send `input_audio` in a supported format, or (recommended, see P2.1) send a transcript instead.

### P0.3 Screenshot auto-submit is never cancelled at the network layer
- `src/hooks/useCompletion.ts:697-705`: `fetchAIResponse` is called **without `signal`**. Superseded requests keep streaming and burning tokens; the UI is only protected by the requestId check. Pass `signal`.

### P0.4 Errors must not become conversation content
- `ai-response.function.ts:399,420,431,442,478,212`: failures are `yield`ed as text chunks. Callers append them to `fullResponse` and `saveCurrentConversation` persists them as assistant turns, which are then resent as history.
- **Fix:** throw typed errors (`AIRequestError {requestId, kind, status}`) and never save a turn whose response errored. Show errors in the error UI slot only.

### P0.5 Stale closures + save race in the overlay
- `useCompletion.ts:201-277`: `saveCurrentConversation` builds `[...state.conversationHistory, user, assistant]` from a closure. That closure is stale if another turn finished in between. `updateConversation` (`chat-history.action.ts:255-339`) then **deletes all messages and reinserts** this stale list, so turns are lost.
- The hotkey callback is registered through an effect (`useCompletion.ts:1156-1183`). Between a state change and effect commit, the old `captureScreenshot` (with old history) is what fires.
- **Fix:**
  - Keep history in a ref (`conversationHistoryRef`) as the single source of truth for request building.
  - Serialize writes through a per-conversation promise queue.
  - Replace delete+reinsert with an append-only `appendMessages(conversationId, msgs)` inside a real transaction (`BEGIN`/`COMMIT`). The current "rollback" code is not a transaction.
- **Done when:** firing the hotkey immediately after a response appears never loses the previous turn (check DB row count).

### P0.6 Event-listener leak on `captured-selection`
- `useCompletion.ts:1062-1131`: `listen()` is async. If the effect cleans up before the promise resolves, `unlisten` is still undefined and the old listener (with old closures and old history) stays alive. The effect re-runs on **every message** because `handleScreenshotSubmit` depends on `state.conversationHistory`. Leaked listeners race the current one, and the shared `isProcessingScreenshotRef` lets whichever runs first win.
- **Fix:** subscribe once (`[]` deps). Call the latest handler through a ref, and use a `cancelled` flag so the listener is disposed even if cleanup happens before `listen` resolves. Apply the same pattern to `useChatCompletion.ts` (it has the same selection flow).

### P0.7 Security: API keys logged to console
- `ai-response.function.ts:352-353`: `console.log("DEBUG: Variables being used:", allVariables)` prints API keys in plaintext. Delete it. (The uncommitted header redaction doesn't cover this.)
- `ai-response.function.ts:349`: `deepVariableReplacer` runs **after** history and user text are inserted into the body. Any message containing `{{API_KEY}}` (or any variable name) gets the secret substituted into the outgoing request. It also runs regexes over multi-MB base64 blobs. **Fix:** substitute variables into the template first, then insert history and the user payload.

### P0.8 Conversation session boundaries in the overlay
- `startNewConversation` only fires on a manual `newConversation` window event (`useCompletion.ts:533`). Nothing else resets it, so one overlay "conversation" spans the whole app session.
- **Fix:** start a new conversation automatically after an idle gap (default 10 min, configurable). Add a "new conversation" global shortcut, and show a small context indicator (turn count, approximate tokens) in the overlay so the user knows what the model sees.

---

## P1: context management (the "efficiency" question)

### P1.1 Persist what was actually sent, not just the prompt label
Today a screenshot turn is stored as `content: "<autoPrompt>"` (`useCompletion.ts:737`). Follow-ups ("and the second part?") have nothing to work with.
**Fix:** store a text record of the turn's inputs: the audio transcript (see P2.1), a `[screenshot attached @ time]` marker, and the prompt. The assistant answer is already stored. That gives follow-ups real context without resending images.

### P1.2 One token-budgeted history builder shared by both hooks
- The request-building logic is duplicated in `useCompletion.submit`, `useCompletion.handleScreenshotSubmit` and `useChatCompletion.submit`, and all three send the **full unbounded history**.
- **Fix:** add `buildRequestHistory(messages, {budgetTokens, keepLastTurns})` in `src/lib/functions/`:
  - Estimate tokens (chars/4 is enough to start; per-provider limits can come later).
  - Always keep the system prompt plus the last K turns verbatim.
  - Drop older turns oldest-first until under budget.
  - Phase 2: replace the dropped turns with a rolling summary (one cheap summarization call when the dropped span exceeds X tokens), stored on the conversation row.
- Images: only the current turn's images are sent (current behaviour, keep it). Optionally re-attach the single most recent screenshot on follow-ups within ~2 minutes.

### P1.3 Unify the two conversation engines
`useCompletion` (overlay) and `useChatCompletion` (history page) are two independent state machines over the same tables, with diverging behaviour: e.g. `getEffectiveProvider()` vs `selectedAIProvider`, and a `signal` passed in one place but not another. Extract a single `conversation-engine` module (send, stream, cancel, persist, history building) and make both hooks thin UI adapters.

### P1.4 Database hygiene
- `getAllConversations` (`chat-history.action.ts:150`) loads **every message of every conversation** to render the list. Select list metadata only, and load messages on open.
- `saveConversation` does a `getConversationById` round trip plus a full rewrite on every turn. Replace it with append (P0.5).
- Add an index on `messages(conversation_id, timestamp)` if the migration doesn't already have one (check `src-tauri` migrations).
- Don't store base64 attachments inline in `attached_files` JSON. Write them to the app data dir and store paths.
- Titles are the raw first message (`generateConversationTitle`). Truncate to about 60 chars; optionally generate a title asynchronously.

---

## P2: meeting audio that actually works

### P2.1 Transcript-first pipeline (the main architectural change)
Raw audio on demand only works with the few providers that accept audio. With others, `ai-response.function.ts:308` **throws** "does not support audio input" and the whole hotkey fails whenever the daemon is on.
**Target design:**
- Chunk the ring buffer with VAD (utterance boundaries, about 5–15 s) and send the chunks to the already-configured STT provider (`stt.function.ts`) in the background.
- Keep a rolling transcript buffer (last N minutes, timestamps, speaker label).
- On hotkey, send the screenshot plus the last N minutes of **transcript text**. This works with every provider, is much cheaper than audio tokens, and the transcript gets stored in history (P1.1).
- Keep raw-audio mode as an option for audio-capable providers.
- **STT engine (decided 2026-09-28):** default to **local on-device Whisper** (`whisper-rs` / whisper.cpp, `base.en` or `small.en`, model downloaded on first use). It costs nothing, keeps meeting audio on the machine, and runs faster than real time on Apple Silicon. Cloud STT stays as an opt-in using the providers already in `src/config/stt.constants.ts` (Google, Groq, OpenAI, Deepgram, …). Google's entry uses v1 sync `speech:recognize`, which caps audio at 60 s per request; VAD chunks of 5–15 s fit under that.
- **Cost reference** (approximate, verify on the pricing pages): continuous transcription of a 1 h meeting costs about $1–1.50 on Google Cloud STT (about $0.016–0.024/min, 60 free min/month), about $0.04 on Groq Whisper, and $0 locally. Only speech segments after VAD are sent, which cuts cloud cost by about 30%.
- **Tradeoff:** 1–3 s transcript lag, plus about 150–500 MB of model download for local Whisper.

### P2.2 Capture both sides of the conversation
- The daemon only taps system output (`system_audio_macos.rs:460`, global tap excluding own process). Your own voice is never captured.
- Add a mic stream captured separately, not mixed, so the transcript can be labelled **Me / Them**. This needs mic permission (see P3).

### P2.3 Detect and surface silent or failed capture
- `app.context.tsx:566`: daemon start failures only go to `console.debug`. Surface them in the UI.
- Compute the RMS / silence ratio on `get_recent_base64`. If the buffer is more than about 95% silent, tell the user ("No system audio captured — check permission / output device") instead of sending 30 s of silence. On macOS a tap without permission can deliver zeros rather than an error; verify this on a clean machine.
- `system_audio.rs:386`: `system_audio_start` returns early if already recording, so **changing `bufferSeconds` while running is ignored**. Restart the capture or apply `set_buffer_seconds` live.
- Minor: `push_samples_realtime` drops samples on `try_lock` contention, and `get_recent_base64` holds the lock while copying 30 s. Copy under the lock, but consider a lock-free SPSC ring if gaps show up.

---

## P3: macOS permissions, signing, distribution

### Why permissions "don't stick"
macOS TCC ties Screen Recording / Microphone / Audio Capture grants to the app's **code signature (designated requirement)**. Unsigned or ad-hoc-signed Tauri builds get a new identity on every build. The old grant still shows as "enabled" in System Settings but doesn't apply to the new binary. That's the "listed but doesn't work until I remove and re-add it" behaviour.

### Findings
- `.github/workflows/publish.yml`: no `APPLE_CERTIFICATE` / `APPLE_SIGNING_IDENTITY` / notarization env for `tauri-action`, so release builds are unsigned.
- `src-tauri/tauri.conf.json:47`: no `signingIdentity`, no `entitlements`, no hardened runtime config.
- `src-tauri/info.plist`: the entitlement keys (`com.apple.security.device.audio-input`, …) are in **Info.plist**, where they have no effect. Entitlements must be in a separate `.entitlements` file passed at signing time. The file is also lower-case `info.plist` and listed under `bundle.resources`, which copies it into `Contents/Resources/` instead of merging it into `Contents/Info.plist`. **Verify** with `plutil -p Runningbord.app/Contents/Info.plist`; if the usage-description keys are missing, macOS can deny prompts outright.
- `NSMicrophoneUsageDescription` text is outdated ("uses virtual audio devices" dates from the BlackHole era).
- `minimumSystemVersion: 10.13`, but system audio requires 14.2+ (runtime check exists at `system_audio_macos.rs:448`). The UI should say this explicitly.
- No microphone permission check exists anywhere in `src/`. Only the screen-recording check does, and it is copy-pasted in 3 places.

### Fix
1. Rename to `src-tauri/Info.plist` (Tauri v2 merges it automatically) and remove it from `bundle.resources`.
2. Create `src-tauri/entitlements.plist` with `com.apple.security.device.audio-input` (and `com.apple.security.cs.allow-jit` etc. only if needed). Set `bundle.macOS.entitlements` and `bundle.macOS.hardenedRuntime: true`.
3. **Local dev:** create a self-signed code-signing certificate in Keychain Access (e.g. "Runningbord Dev") and set `bundle.macOS.signingIdentity` to it. The identity then stays stable across rebuilds and grants persist. Document `tccutil reset ScreenCapture com.srikanthnani.runningbord` (plus `Microphone`, `AudioCapture`) for resetting.
4. **Release (decided 2026-09-28: no paid Apple Developer account).** Sign CI builds with **one long-lived self-signed code-signing certificate**, stored as a GitHub secret (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, with no notarization vars).
   - TCC keys grants on the designated requirement (bundle id + certificate), so as long as the same certificate signs every release, **permissions survive updates**. This is the main win.
   - Gatekeeper will still warn on first launch because the build isn't notarized. Document the workaround in the README: right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Runningbord.app`.
   - Don't rotate the certificate. Rotating it resets every user's permissions once.
   - Users who build from source should use their own stable local certificate (step 3).
5. **Permissions onboarding screen:** one place that checks and requests Screen Recording, Microphone and System Audio. System Audio has no public query API; infer it from silent-tap detection (P2.3). Add deep links to the right System Settings panes, a "restart required" notice after granting screen recording, and a re-check on app focus. Replace the 3 copy-pasted permission checks with this.
6. Verify each build: `codesign -dv --verbose=4`, `codesign -d --entitlements - <app>`, `spctl -a -vv <app>`.

---

## P4: observability (finish the in-progress work)

The uncommitted diff in `ai-response.function.ts` adds a `requestId` plus redacted network-failure logging. Extend it:
- **One requestId end to end:** generate it in the hook (already done via `generateRequestId`), pass it into `fetchAIResponse` (drop the second `buildRequestId`) and into Rust (P0.1).
- **Success-path log per request:** provider, history turns sent, estimated tokens, image count/bytes, audio duration, silence ratio, transcript length, time to first chunk. `emitShortcutPipelineMetrics` (`useCompletion.ts:760`) already collects most of this; unify with it.
- **Dev-only "last request inspector"** panel showing exactly what was sent (redacted). This is how the next "stale response" gets diagnosed in a minute instead of guessed at.

---

## Suggested order

| Step | Items | Size | Why first |
|---|---|---|---|
| 1 | P0.7, P0.4, P0.3, P0.6 | S | Small, isolated, removes a security leak + context pollution |
| 2 | P0.1, P0.2 (+ Rust) | M | Main stale-response cause on the hosted path |
| 3 | P0.5, P0.8, P1.4 append-only | M | Stops lost turns + cross-session bleed |
| 4 | P4 | S | Evidence for anything still flaky |
| 5 | P1.1, P1.2, P1.3 | L | Context quality + efficiency, single engine |
| 6 | P3 (1–3, 5–6) | M | Permissions that survive rebuilds; release signing (4) needs your Apple account |
| 7 | P2.3 → P2.1 → P2.2 | L | Meeting mode rebuild |

## Decisions (2026-09-28)
- No paid Apple Developer account. Use a stable self-signed certificate for CI + local builds, with no notarization (P3.4).
- Transcript-first meeting mode. Local Whisper by default, cloud STT (incl. Google) opt-in (P2.1).
- Auto-new-conversation after 10 min idle, configurable (P0.8).
- Still open: default transcript window sent per hotkey (proposal: last 5 min).
