//! Live background transcription. A worker pulls new audio from the system and
//! mic ring buffers, cuts it into utterances with an energy-based VAD, and
//! transcribes each finished utterance with Whisper. A shortcut press then only
//! reads the stored transcript plus the utterance still in progress.

use crate::local_stt::{
    context_for, looks_like_echo, remove_echo, run_whisper, spec, LocalSttState, TranscriptResult,
    TranscriptSegment,
};
use crate::mic_audio::MicAudioState;
use crate::speaker_id::{Extractor, SpeakerClusters};
use crate::system_audio::{silence_ratio, SystemAudioState};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SAMPLE_RATE: usize = 16_000;
const FRAME: usize = SAMPLE_RATE / 50; // 20 ms
/// Minimum RMS that can count as voice activity (roughly -42 dBFS).
const SPEECH_RMS: f32 = 0.008;
/// Voice must be this much louder than the background noise floor. Meeting
/// audio is rarely silent, so a fixed threshold never sees the pauses.
const SPEECH_OVER_NOISE: f32 = 2.5;
/// The noise floor is the quietest frame in this many recent frames (3 s):
/// speech always has short dips between words, background noise doesn't.
const NOISE_WINDOW_FRAMES: usize = 150;
/// Silence that ends an utterance.
const END_SILENCE: usize = SAMPLE_RATE / 2;
/// Audio kept before the first speech frame so word onsets aren't clipped.
const LEAD_IN: usize = SAMPLE_RATE * 3 / 10;
/// Long monologues are cut so final text keeps flowing.
const MAX_UTTERANCE: usize = SAMPLE_RATE * 10;
/// Utterances with less speech than this are clicks/noise.
const MIN_SPEECH: usize = SAMPLE_RATE * 3 / 10;
/// The mic hears typing and desk bumps, so it needs more speech to count.
const MIN_MIC_SPEECH: usize = SAMPLE_RATE / 2;
/// How long a mic line waits for the matching meeting-audio line, so echo of
/// the speakers (no headphones) can be recognised before it's shown.
const ECHO_HOLD_MS: u64 = 1_500;
/// A mic line within this long of a meeting-audio line can be its echo.
const ECHO_SLACK_MS: u64 = 1_500;

fn min_speech(source: &str) -> usize {
    if source == "mic" {
        MIN_MIC_SPEECH
    } else {
        MIN_SPEECH
    }
}
/// How often the utterance still being spoken is re-transcribed for the preview.
const PARTIAL_EVERY: usize = SAMPLE_RATE;
/// How long transcript lines are kept.
const RETENTION_MS: u64 = 15 * 60 * 1000;
const POLL: Duration = Duration::from_millis(250);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn frame_rms(frame: &[f32]) -> f32 {
    (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt()
}

/// Per-source utterance segmenter.
#[derive(Default)]
struct Track {
    cursor: usize,
    /// Audio not yet assigned to a finished utterance.
    pending: Vec<f32>,
    /// Samples at the end of `pending` that were already classified.
    scanned: usize,
    in_speech: bool,
    speech_samples: usize,
    trailing_silence: usize,
    /// RMS of recent frames, for the adaptive noise floor.
    recent_rms: VecDeque<f32>,
    /// `pending.len()` when the last partial result was produced.
    partial_mark: usize,
}

struct Chunk {
    source: &'static str,
    samples: Vec<f32>,
    /// Wall-clock time of the chunk's last sample.
    end_ms: u64,
}

impl Track {
    /// Pull new audio and return any utterances that finished.
    fn pump(&mut self, buffer: &SystemAudioState, source: &'static str) -> Vec<Chunk> {
        let (samples, end) = buffer.samples_since(self.cursor);
        if end < self.cursor {
            *self = Track::default(); // capture restarted
        }
        self.cursor = end;
        let captured_at = now_ms();
        self.pending.extend_from_slice(&samples);

        let mut chunks = Vec::new();
        while self.pending.len() - self.scanned >= FRAME {
            let rms = frame_rms(&self.pending[self.scanned..self.scanned + FRAME]);
            let speech = self.is_speech(rms);
            self.scanned += FRAME;

            if !self.in_speech {
                if speech {
                    self.in_speech = true;
                    self.speech_samples = FRAME;
                    self.trailing_silence = 0;
                    // Keep a short lead-in, drop older silence.
                    let keep_from = self.scanned.saturating_sub(FRAME + LEAD_IN);
                    self.pending.drain(..keep_from);
                    self.scanned -= keep_from;
                } else if self.scanned > LEAD_IN {
                    let drop = self.scanned - LEAD_IN;
                    self.pending.drain(..drop);
                    self.scanned -= drop;
                }
                continue;
            }

            if speech {
                self.speech_samples += FRAME;
                self.trailing_silence = 0;
            } else {
                self.trailing_silence += FRAME;
            }

            if self.trailing_silence >= END_SILENCE || self.scanned >= MAX_UTTERANCE {
                let samples: Vec<f32> = self.pending.drain(..self.scanned).collect();
                let unread_after = self.pending.len();
                if self.speech_samples >= min_speech(source) {
                    chunks.push(Chunk {
                        source,
                        samples,
                        end_ms: captured_at
                            .saturating_sub((unread_after * 1000 / SAMPLE_RATE) as u64),
                    });
                }
                self.scanned = 0;
                self.partial_mark = 0;
                // A forced cut mid-speech continues as a new utterance.
                self.in_speech = self.trailing_silence < END_SILENCE;
                self.speech_samples = 0;
                self.trailing_silence = 0;
            }
        }
        chunks
    }

    fn is_speech(&mut self, rms: f32) -> bool {
        if self.recent_rms.len() == NOISE_WINDOW_FRAMES {
            self.recent_rms.pop_front();
        }
        self.recent_rms.push_back(rms);
        let noise_floor = self.recent_rms.iter().copied().fold(f32::INFINITY, f32::min);
        rms > SPEECH_RMS.max(noise_floor * SPEECH_OVER_NOISE)
    }

    /// The utterance in progress, once per PARTIAL_EVERY of new audio, for a
    /// live preview of words as they are spoken.
    fn take_partial(&mut self, source: &'static str) -> Option<Chunk> {
        if self.pending.len() < self.partial_mark + PARTIAL_EVERY {
            return None;
        }
        let chunk = self.in_progress(source)?;
        self.partial_mark = self.pending.len();
        Some(chunk)
    }

    /// The utterance still being spoken, if any (not consumed).
    fn in_progress(&self, source: &'static str) -> Option<Chunk> {
        if !self.in_speech || self.speech_samples < min_speech(source) {
            return None;
        }
        Some(Chunk {
            source,
            samples: self.pending.clone(),
            end_ms: now_ms(),
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSegment {
    source: &'static str,
    start_ms: u64,
    end_ms: u64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker: Option<String>,
}

/// Words of the utterance still being spoken; replaced by the final segment.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LivePartial {
    source: &'static str,
    text: String,
}

struct LiveConfig {
    model_id: String,
    language: String,
    separate_speakers: bool,
}

#[derive(Default)]
pub struct LiveTranscriber {
    running: Arc<AtomicBool>,
    config: Mutex<Option<LiveConfig>>,
    system: Mutex<Track>,
    mic: Mutex<Track>,
    segments: Mutex<VecDeque<LiveSegment>>,
    /// Mic lines waiting for the echo check, with when to release them.
    held_mic: Mutex<Vec<(LiveSegment, u64)>>,
    speakers: Mutex<SpeakerClusters>,
    extractor: Mutex<Option<Extractor>>,
    last_error: Mutex<Option<String>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    /// Everything transcribed since Meeting mode was turned on, for meeting
    /// notes. Kept after stopping until the next session starts.
    session: Mutex<Session>,
}

/// Lines kept per session (several hours of conversation).
const SESSION_MAX_SEGMENTS: usize = 20_000;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    started_ms: u64,
    ended_ms: Option<u64>,
    segments: Vec<LiveSegment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    running: bool,
    model_id: Option<String>,
    segment_count: usize,
    last_error: Option<String>,
}

struct Deps {
    app: AppHandle,
    live: Arc<LiveTranscriber>,
    system: Arc<SystemAudioState>,
    mic: Arc<MicAudioState>,
    stt: Arc<LocalSttState>,
}

impl Deps {
    fn language(&self) -> Option<(String, String)> {
        let config = self.live.config.lock().ok()?;
        let config = config.as_ref()?;
        Some((config.model_id.clone(), config.language.clone()))
    }

    fn separate_speakers(&self) -> bool {
        self.live
            .config
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|c| c.separate_speakers))
            .unwrap_or(false)
    }

    /// Speaker label for a system-audio utterance, if separation is on and works.
    fn speaker_for(&self, chunk: &Chunk, learn: bool) -> Option<String> {
        if chunk.source != "system" || !self.separate_speakers() {
            return None;
        }
        let mut extractor = self.live.extractor.lock().ok()?;
        if extractor.is_none() {
            match Extractor::load(&self.app) {
                Ok(e) => *extractor = Some(e),
                Err(e) => {
                    tracing::warn!("Speaker separation unavailable: {}", e);
                    return None;
                }
            }
        }
        let embedding = extractor.as_mut()?.embed(&chunk.samples).ok()?;
        let seconds = chunk.samples.len() as f32 / SAMPLE_RATE as f32;
        self.live.speakers.lock().ok()?.assign(embedding, seconds, learn)
    }

    fn pump_all(&self) -> Vec<Chunk> {
        let mut chunks = Vec::new();
        if let Ok(mut track) = self.live.system.lock() {
            chunks.extend(track.pump(&self.system, "system"));
        }
        if self.mic.buffer.is_recording() {
            if let Ok(mut track) = self.live.mic.lock() {
                chunks.extend(track.pump(&self.mic.buffer, "mic"));
            }
        }
        chunks
    }

    fn transcribe(&self, chunk: &Chunk, learn_speaker: bool) -> Result<Vec<LiveSegment>, String> {
        let (model_id, language) = self.language().ok_or("Live transcription is not configured")?;
        let language = if spec(&model_id)?.multilingual {
            language
        } else {
            "en".to_string()
        };
        let ctx = context_for(&self.app, &self.stt, &model_id)?;
        let segments = {
            let _guard = self.stt.whisper_lock.lock().map_err(|e| e.to_string())?;
            run_whisper(&ctx, &chunk.samples, &language, chunk.source)?
        };
        let speaker = if segments.is_empty() {
            None
        } else {
            self.speaker_for(chunk, learn_speaker)
        };
        Ok(segments
            .into_iter()
            .map(|s| LiveSegment {
                source: s.source,
                start_ms: offset_to_ms(chunk.end_ms, s.start_offset),
                end_ms: offset_to_ms(chunk.end_ms, s.end_offset),
                text: s.text,
                speaker: speaker.clone(),
            })
            .collect())
    }

    /// Store new lines. Mic lines are held briefly and dropped if they turn
    /// out to be the meeting audio heard through the mic.
    fn store(&self, new: Vec<LiveSegment>) {
        let (mic, system): (Vec<_>, Vec<_>) = new.into_iter().partition(|s| s.source == "mic");
        self.commit(system);
        if !mic.is_empty() {
            let release_at = now_ms() + ECHO_HOLD_MS;
            if let Ok(mut held) = self.live.held_mic.lock() {
                held.extend(mic.into_iter().map(|s| (s, release_at)));
            }
        }
        self.release_mic(false);
    }

    /// Drop held mic lines that echo a meeting-audio line; commit the ones
    /// whose hold has passed (or all of them, with `all`).
    fn release_mic(&self, all: bool) {
        let held = match self.live.held_mic.lock() {
            Ok(mut held) => std::mem::take(&mut *held),
            Err(_) => return,
        };
        if held.is_empty() {
            return;
        }
        let system: Vec<LiveSegment> = self
            .live
            .segments
            .lock()
            .map(|s| s.iter().filter(|s| s.source == "system").cloned().collect())
            .unwrap_or_default();
        let now = now_ms();
        let mut ready = Vec::new();
        let mut keep = Vec::new();
        for (segment, release_at) in held {
            let echo = system.iter().any(|s| {
                segment.start_ms <= s.end_ms + ECHO_SLACK_MS
                    && s.start_ms <= segment.end_ms + ECHO_SLACK_MS
                    && looks_like_echo(&segment.text, &s.text)
            });
            if echo {
                continue;
            }
            if all || now >= release_at {
                ready.push(segment);
            } else {
                keep.push((segment, release_at));
            }
        }
        if let Ok(mut held) = self.live.held_mic.lock() {
            held.extend(keep);
        }
        self.commit(ready);
    }

    fn commit(&self, new: Vec<LiveSegment>) {
        if new.is_empty() {
            return;
        }
        for segment in &new {
            let _ = self.app.emit("live-transcript-segment", segment.clone());
        }
        if let Ok(mut session) = self.live.session.lock() {
            if session.segments.len() < SESSION_MAX_SEGMENTS {
                session.segments.extend(new.iter().cloned());
            }
        }
        if let Ok(mut segments) = self.live.segments.lock() {
            segments.extend(new);
            segments
                .make_contiguous()
                .sort_by_key(|s| (s.start_ms, s.end_ms));
            let cutoff = now_ms().saturating_sub(RETENTION_MS);
            while segments.front().map(|s| s.end_ms < cutoff).unwrap_or(false) {
                segments.pop_front();
            }
        }
    }

    fn process(&self, chunks: Vec<Chunk>) {
        for chunk in chunks {
            match self.transcribe(&chunk, true) {
                Ok(segments) => {
                    self.store(segments);
                    if let Ok(mut e) = self.live.last_error.lock() {
                        *e = None;
                    }
                }
                Err(e) => {
                    tracing::warn!("Live transcription failed: {}", e);
                    if let Ok(mut last) = self.live.last_error.lock() {
                        *last = Some(e);
                    }
                }
            }
        }
    }
}

fn offset_to_ms(end_ms: u64, offset_seconds: f32) -> u64 {
    let offset_ms = (-offset_seconds * 1000.0).max(0.0) as u64;
    end_ms.saturating_sub(offset_ms)
}

impl Deps {
    fn emit_partials(&self) {
        let mut partials = Vec::new();
        if let Ok(mut track) = self.live.system.lock() {
            partials.extend(track.take_partial("system"));
        }
        // While meeting audio is playing, words on the mic are mostly echo of it;
        // skip the mic preview then (finished lines still get the echo check).
        let others_speaking = self.live.system.lock().map(|t| t.in_speech).unwrap_or(false);
        if self.mic.buffer.is_recording() && !others_speaking {
            if let Ok(mut track) = self.live.mic.lock() {
                partials.extend(track.take_partial("mic"));
            }
        }
        for chunk in partials {
            if let Ok(segments) = self.transcribe_text_only(&chunk) {
                let text = segments.join(" ");
                if !text.is_empty() {
                    let _ = self.app.emit(
                        "live-transcript-partial",
                        LivePartial {
                            source: chunk.source,
                            text,
                        },
                    );
                }
            }
        }
    }

    /// Whisper only (no speaker id), for partial results.
    fn transcribe_text_only(&self, chunk: &Chunk) -> Result<Vec<String>, String> {
        let (model_id, language) = self.language().ok_or("Live transcription is not configured")?;
        let language = if spec(&model_id)?.multilingual {
            language
        } else {
            "en".to_string()
        };
        let ctx = context_for(&self.app, &self.stt, &model_id)?;
        let _guard = self.stt.whisper_lock.lock().map_err(|e| e.to_string())?;
        Ok(run_whisper(&ctx, &chunk.samples, &language, chunk.source)?
            .into_iter()
            .map(|s| s.text)
            .collect())
    }
}

fn worker_loop(deps: Deps) {
    while deps.live.running.load(Ordering::SeqCst) {
        let started = Instant::now();
        let chunks = deps.pump_all();
        deps.process(chunks);
        deps.release_mic(false);
        deps.emit_partials();
        if let Some(rest) = POLL.checked_sub(started.elapsed()) {
            thread::sleep(rest);
        }
    }
}

#[tauri::command]
pub async fn live_transcript_start(
    app: AppHandle,
    model_id: String,
    language: Option<String>,
    separate_speakers: Option<bool>,
    live: tauri::State<'_, Arc<LiveTranscriber>>,
    system: tauri::State<'_, Arc<SystemAudioState>>,
    mic: tauri::State<'_, Arc<MicAudioState>>,
    stt: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<(), String> {
    spec(&model_id)?;
    // Fail fast (e.g. model not downloaded) instead of erroring on every utterance.
    {
        let (app, stt, model_id) = (app.clone(), stt.inner().clone(), model_id.clone());
        tauri::async_runtime::spawn_blocking(move || context_for(&app, &stt, &model_id).map(|_| ()))
            .await
            .map_err(|e| e.to_string())??;
    }

    *live.config.lock().map_err(|e| e.to_string())? = Some(LiveConfig {
        model_id,
        language: language
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
        separate_speakers: separate_speakers.unwrap_or(false),
    });

    if live.running.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running; config updated above
    }
    let started_ms = now_ms();
    *live.session.lock().map_err(|e| e.to_string())? = Session {
        started_ms,
        ..Session::default()
    };
    let _ = app.emit("meeting-started", serde_json::json!({ "startedMs": started_ms }));
    // Start from "now": don't transcribe the whole existing buffer.
    live.system.lock().map_err(|e| e.to_string())?.cursor = system.written_position();
    live.mic.lock().map_err(|e| e.to_string())?.cursor = mic.buffer.written_position();

    let deps = Deps {
        app,
        live: live.inner().clone(),
        system: system.inner().clone(),
        mic: mic.inner().clone(),
        stt: stt.inner().clone(),
    };
    let handle = thread::Builder::new()
        .name("live-transcript".into())
        .spawn(move || worker_loop(deps))
        .map_err(|e| e.to_string())?;
    *live.worker.lock().map_err(|e| e.to_string())? = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn live_transcript_stop(
    app: AppHandle,
    live: tauri::State<'_, Arc<LiveTranscriber>>,
) -> Result<(), String> {
    let was_running = live.running.swap(false, Ordering::SeqCst);
    let handle = live.worker.lock().map_err(|e| e.to_string())?.take();
    if let Some(handle) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || handle.join()).await;
    }
    *live.system.lock().map_err(|e| e.to_string())? = Track::default();
    *live.mic.lock().map_err(|e| e.to_string())? = Track::default();
    live.segments.lock().map_err(|e| e.to_string())?.clear();
    live.held_mic.lock().map_err(|e| e.to_string())?.clear();
    // A new session is a new meeting: forget the voices.
    live.speakers.lock().map_err(|e| e.to_string())?.reset();
    if was_running {
        let summary = {
            let mut session = live.session.lock().map_err(|e| e.to_string())?;
            session.ended_ms = Some(now_ms());
            serde_json::json!({
                "startedMs": session.started_ms,
                "endedMs": session.ended_ms,
                "segmentCount": session.segments.len(),
            })
        };
        let _ = app.emit("meeting-ended", summary);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerStats {
    /// "You" for the microphone, otherwise "Speaker N" or "Them".
    label: String,
    source: &'static str,
    lines: usize,
    words: usize,
    talk_ms: u64,
    last_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    started_ms: u64,
    ended_ms: Option<u64>,
    speakers: Vec<SpeakerStats>,
    /// Longest stretch of the user talking without anyone else speaking.
    longest_monologue_ms: u64,
    /// The stretch the user is in right now (0 if someone else spoke last or
    /// the user has been quiet for a few seconds).
    current_monologue_ms: u64,
}

/// A pause longer than this ends the user's current stretch of talking.
const MONOLOGUE_GAP_MS: u64 = 5_000;

/// (longest, current) stretch of the user talking with nobody else speaking in
/// between, from segments in time order. A pause over MONOLOGUE_GAP_MS ends a
/// stretch; the current one only counts while the session runs.
fn monologues(ordered: &[&LiveSegment], ended: bool, now: u64) -> (u64, u64) {
    let mut longest = 0;
    let mut run: Option<(u64, u64)> = None;
    for segment in ordered {
        if segment.source == "mic" {
            run = match run {
                Some((start, end)) if segment.start_ms <= end + MONOLOGUE_GAP_MS => {
                    Some((start, end.max(segment.end_ms)))
                }
                _ => Some((segment.start_ms, segment.end_ms)),
            };
            if let Some((start, end)) = run {
                longest = longest.max(end - start);
            }
        } else {
            run = None;
        }
    }
    let current = match run {
        Some((start, end)) if !ended && now <= end + MONOLOGUE_GAP_MS => end - start,
        _ => 0,
    };
    (longest, current)
}

/// Per-speaker totals for the current (or most recent) session: who spoke,
/// for how long, and what they said last.
#[tauri::command]
pub async fn live_transcript_stats(
    live: tauri::State<'_, Arc<LiveTranscriber>>,
) -> Result<SessionStats, String> {
    let session = live.session.lock().map_err(|e| e.to_string())?;
    let mut speakers: Vec<SpeakerStats> = Vec::new();
    let mut ordered: Vec<&LiveSegment> = session.segments.iter().collect();
    ordered.sort_by_key(|s| (s.start_ms, s.end_ms));
    let (longest_monologue_ms, current_monologue_ms) =
        monologues(&ordered, session.ended_ms.is_some(), now_ms());
    for segment in ordered {
        let label = if segment.source == "mic" {
            "You".to_string()
        } else {
            segment.speaker.clone().unwrap_or_else(|| "Them".to_string())
        };
        let entry = match speakers.iter_mut().position(|s| s.label == label) {
            Some(i) => &mut speakers[i],
            None => {
                speakers.push(SpeakerStats {
                    label,
                    source: segment.source,
                    lines: 0,
                    words: 0,
                    talk_ms: 0,
                    last_text: String::new(),
                });
                speakers.last_mut().unwrap()
            }
        };
        entry.lines += 1;
        entry.words += segment.text.split_whitespace().count();
        entry.talk_ms += segment.end_ms.saturating_sub(segment.start_ms);
        entry.last_text = segment.text.trim().to_string();
    }
    Ok(SessionStats {
        started_ms: session.started_ms,
        ended_ms: session.ended_ms,
        speakers,
        longest_monologue_ms,
        current_monologue_ms,
    })
}

/// The whole transcript of the current (or most recently ended) session.
#[tauri::command]
pub async fn live_transcript_session(
    live: tauri::State<'_, Arc<LiveTranscriber>>,
) -> Result<Session, String> {
    let mut session = live.session.lock().map_err(|e| e.to_string())?.clone();
    session.segments.sort_by_key(|s| (s.start_ms, s.end_ms));
    Ok(session)
}

#[tauri::command]
pub async fn live_transcript_status(
    live: tauri::State<'_, Arc<LiveTranscriber>>,
) -> Result<LiveStatus, String> {
    Ok(LiveStatus {
        running: live.running.load(Ordering::SeqCst),
        model_id: live
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|c| c.model_id.clone()),
        segment_count: live.segments.lock().map_err(|e| e.to_string())?.len(),
        last_error: live.last_error.lock().map_err(|e| e.to_string())?.clone(),
    })
}

/// Transcript of the last `window_seconds`, as offsets relative to now. Finishes
/// any utterance that just ended and includes the one still being spoken.
#[tauri::command]
pub async fn live_transcript_get(
    app: AppHandle,
    window_seconds: u32,
    finalize: Option<bool>,
    live: tauri::State<'_, Arc<LiveTranscriber>>,
    system: tauri::State<'_, Arc<SystemAudioState>>,
    mic: tauri::State<'_, Arc<MicAudioState>>,
    stt: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<TranscriptResult, String> {
    if !live.running.load(Ordering::SeqCst) {
        return Err("Live transcription is not running".to_string());
    }
    let deps = Deps {
        app,
        live: live.inner().clone(),
        system: system.inner().clone(),
        mic: mic.inner().clone(),
        stt: stt.inner().clone(),
    };
    let started = Instant::now();

    // `finalize: false` returns what's already transcribed without waiting on
    // Whisper, for automatic answers where the question is already final.
    let finalize = finalize.unwrap_or(true);
    let (segments, system_ratio, mic_ratio) = tauri::async_runtime::spawn_blocking(move || {
        let mut provisional = Vec::new();
        if finalize {
            deps.process(deps.pump_all());
            deps.release_mic(true);
            let in_progress = [
                deps.live.system.lock().ok().and_then(|t| t.in_progress("system")),
                deps.live.mic.lock().ok().and_then(|t| t.in_progress("mic")),
            ];
            for chunk in in_progress.into_iter().flatten() {
                if let Ok(segments) = deps.transcribe(&chunk, false) {
                    provisional.extend(segments);
                }
            }
        }

        let now = now_ms();
        let from = now.saturating_sub(window_seconds as u64 * 1000);
        let mut window: Vec<LiveSegment> = deps
            .live
            .segments
            .lock()
            .map(|s| s.iter().filter(|s| s.end_ms >= from).cloned().collect())
            .unwrap_or_default();
        window.extend(provisional);

        let to_segment = |s: &LiveSegment| TranscriptSegment {
            source: s.source,
            start_offset: (s.start_ms as f32 - now as f32) / 1000.0,
            end_offset: (s.end_ms as f32 - now as f32) / 1000.0,
            text: s.text.clone(),
            speaker: s.speaker.clone(),
        };
        let system_segments: Vec<TranscriptSegment> = window
            .iter()
            .filter(|s| s.source == "system")
            .map(to_segment)
            .collect();
        let mic_segments = remove_echo(
            window.iter().filter(|s| s.source == "mic").map(to_segment).collect(),
            &system_segments,
        );
        let mut all: Vec<TranscriptSegment> =
            system_segments.into_iter().chain(mic_segments).collect();
        all.sort_by(|a, b| a.start_offset.total_cmp(&b.start_offset));

        // Silence stats over the ring-buffer part of the window, for warnings.
        let seconds = Some(window_seconds);
        let system_ratio = deps
            .system
            .recent_samples(seconds)
            .map(|s| silence_ratio(&s))
            .unwrap_or(1.0);
        let mic_ratio = if deps.mic.buffer.is_recording() {
            deps.mic.buffer.recent_samples(seconds).ok().map(|s| silence_ratio(&s))
        } else {
            None
        };
        (all, system_ratio, mic_ratio)
    })
    .await
    .map_err(|e| e.to_string())?;

    let text = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Ok(TranscriptResult {
        silent: segments.iter().all(|s| s.source != "system") && system_ratio >= 0.97,
        segments,
        text,
        silence_ratio: system_ratio,
        mic_silence_ratio: mic_ratio,
        audio_seconds: window_seconds as f32,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
        (0..(seconds * SAMPLE_RATE as f32) as usize)
            .map(|i| (i as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * amplitude)
            .collect()
    }

    /// Syllable-like envelope (4 Hz, dipping to 10%), like real speech energy.
    fn speech(seconds: f32, amplitude: f32) -> Vec<f32> {
        tone(seconds, amplitude)
            .into_iter()
            .enumerate()
            .map(|(i, s)| {
                let t = i as f32 / SAMPLE_RATE as f32;
                s * (0.55 + 0.45 * (t * 4.0 * std::f32::consts::TAU).sin())
            })
            .collect()
    }

    /// Deterministic broadband noise with the given RMS-ish level.
    fn noise(seconds: f32, amplitude: f32) -> Vec<f32> {
        let mut x: u32 = 12345;
        (0..(seconds * SAMPLE_RATE as f32) as usize)
            .map(|_| {
                x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                ((x >> 16) as f32 / 32_768.0 - 1.0) * amplitude
            })
            .collect()
    }

    fn mix(a: Vec<f32>, b: &[f32]) -> Vec<f32> {
        a.into_iter().zip(b).map(|(x, y)| x + y).collect()
    }

    fn feed(buffer: &SystemAudioState, samples: &[f32]) {
        for chunk in samples.chunks(1600) {
            buffer.push_samples_realtime(chunk);
        }
    }

    fn buffer() -> SystemAudioState {
        let b = SystemAudioState::new();
        b.set_buffer_seconds(60);
        b.set_recording(true);
        b
    }

    #[test]
    fn utterance_is_cut_after_trailing_silence() {
        let b = buffer();
        let mut track = Track::default();
        feed(&b, &tone(1.0, 0.0));
        feed(&b, &speech(2.0, 0.2));
        assert!(track.pump(&b, "system").is_empty(), "still speaking");
        assert!(track.in_progress("system").is_some());

        feed(&b, &tone(1.0, 0.0));
        let chunks = track.pump(&b, "system");
        assert_eq!(chunks.len(), 1);
        let secs = chunks[0].samples.len() as f32 / SAMPLE_RATE as f32;
        // 2 s speech + lead-in + ~0.5 s silence, with the leading silence dropped.
        assert!((2.4..3.1).contains(&secs), "chunk was {secs}s");
        assert!(track.in_progress("system").is_none());
    }

    #[test]
    fn silence_and_short_clicks_produce_nothing() {
        let b = buffer();
        let mut track = Track::default();
        feed(&b, &tone(5.0, 0.0));
        feed(&b, &tone(0.1, 0.3));
        feed(&b, &tone(2.0, 0.0));
        assert!(track.pump(&b, "system").is_empty());
        assert!(track.pending.len() <= LEAD_IN + FRAME, "silence must not accumulate");
    }

    /// WHISPER_TEST_MODEL=... WHISPER_TEST_WAV=... cargo test --release live_real_speech -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_real_speech() {
        use whisper_rs::{WhisperContext, WhisperContextParameters};
        let model = std::env::var("WHISPER_TEST_MODEL").expect("WHISPER_TEST_MODEL");
        let wav = std::fs::read(std::env::var("WHISPER_TEST_WAV").expect("WHISPER_TEST_WAV")).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let speech: Vec<f32> = wav[data..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
            .collect();

        let b = buffer();
        let mut track = Track::default();
        let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let mut texts = Vec::new();
        // Stream in 0.5 s blocks like the worker does.
        let mut audio = tone(1.0, 0.0);
        audio.extend_from_slice(&speech);
        audio.extend(tone(1.5, 0.0));
        for block in audio.chunks(SAMPLE_RATE / 2) {
            feed(&b, block);
            for chunk in track.pump(&b, "system") {
                let started = Instant::now();
                let segs = run_whisper(&ctx, &chunk.samples, "en", "system").unwrap();
                let text = segs.iter().map(|s| s.text.clone()).collect::<Vec<_>>().join(" ");
                println!(
                    "chunk {:.1}s -> {:?} in {:?}",
                    chunk.samples.len() as f32 / SAMPLE_RATE as f32,
                    text,
                    started.elapsed()
                );
                texts.push(text);
            }
        }
        let all = texts.join(" ").to_lowercase();
        assert!(all.contains("fellow americans"), "{all}");
        assert!(all.contains("what you can do for your country"), "{all}");
        assert!(track.in_progress("system").is_none());
    }

    #[test]
    fn pauses_are_found_in_noisy_meeting_audio() {
        let b = buffer();
        let mut track = Track::default();
        // Constant background noise well above the fixed -42 dBFS floor.
        let mut audio = noise(1.0, 0.05);
        for _ in 0..3 {
            let s = speech(2.0, 0.3);
            audio.extend(mix(s.clone(), &noise(2.0, 0.05)));
            audio.extend(noise(0.8, 0.05)); // a pause, but not silence
        }
        feed(&b, &audio);
        let chunks = track.pump(&b, "system");
        assert_eq!(chunks.len(), 3, "each sentence should end at its pause");
    }

    #[test]
    fn partial_results_arrive_every_second_of_speech() {
        let b = buffer();
        let mut track = Track::default();
        feed(&b, &speech(0.6, 0.2));
        track.pump(&b, "system");
        assert!(track.take_partial("system").is_none(), "under a second");
        feed(&b, &speech(0.6, 0.2));
        track.pump(&b, "system");
        assert!(track.take_partial("system").is_some());
        assert!(track.take_partial("system").is_none(), "no new audio yet");
        feed(&b, &speech(1.0, 0.2));
        track.pump(&b, "system");
        assert!(track.take_partial("system").is_some());
    }

    #[test]
    fn long_monologue_is_split() {
        let b = buffer();
        let mut track = Track::default();
        feed(&b, &speech(45.0, 0.2));
        let chunks = track.pump(&b, "system");
        assert_eq!(chunks.len(), 4);
        assert!(chunks.iter().all(|c| c.samples.len() <= MAX_UTTERANCE));
        assert!(track.in_progress("system").is_some());
    }
}

#[cfg(test)]
mod monologue_tests {
    use super::*;

    fn seg(source: &'static str, start_ms: u64, end_ms: u64) -> LiveSegment {
        LiveSegment { source, start_ms, end_ms, text: String::new(), speaker: None }
    }

    #[test]
    fn stretches_break_on_other_speakers_and_long_pauses() {
        let segments = [
            seg("mic", 0, 10_000),
            seg("mic", 12_000, 30_000), // short pause: same stretch (30s)
            seg("system", 31_000, 35_000),
            seg("mic", 36_000, 40_000),
            seg("mic", 50_000, 70_000), // 10s pause: new stretch (20s)
        ];
        let ordered: Vec<&LiveSegment> = segments.iter().collect();
        assert_eq!(monologues(&ordered, false, 72_000), (30_000, 20_000));
        // Quiet for a while, or the meeting ended: no current stretch.
        assert_eq!(monologues(&ordered, false, 90_000), (30_000, 0));
        assert_eq!(monologues(&ordered, true, 72_000), (30_000, 0));
    }
}
