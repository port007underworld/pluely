//! Live background transcription. A worker pulls new audio from the system and
//! mic ring buffers, cuts it into utterances with an energy-based VAD, and
//! transcribes each finished utterance with Whisper. A shortcut press then only
//! reads the stored transcript plus the utterance still in progress.

use crate::local_stt::{
    context_for, remove_echo, run_whisper, spec, LocalSttState, TranscriptResult,
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
/// RMS above this counts as voice activity (roughly -42 dBFS).
const SPEECH_RMS: f32 = 0.008;
/// Silence that ends an utterance.
const END_SILENCE: usize = SAMPLE_RATE * 7 / 10;
/// Audio kept before the first speech frame so word onsets aren't clipped.
const LEAD_IN: usize = SAMPLE_RATE * 3 / 10;
/// Long monologues are cut so text keeps flowing.
const MAX_UTTERANCE: usize = SAMPLE_RATE * 20;
/// Utterances with less speech than this are clicks/noise.
const MIN_SPEECH: usize = SAMPLE_RATE * 3 / 10;
/// How long transcript lines are kept.
const RETENTION_MS: u64 = 15 * 60 * 1000;
const POLL: Duration = Duration::from_millis(500);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn frame_is_speech(frame: &[f32]) -> bool {
    let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt();
    rms > SPEECH_RMS
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
            let frame = &self.pending[self.scanned..self.scanned + FRAME];
            let speech = frame_is_speech(frame);
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
                if self.speech_samples >= MIN_SPEECH {
                    chunks.push(Chunk {
                        source,
                        samples,
                        end_ms: captured_at
                            .saturating_sub((unread_after * 1000 / SAMPLE_RATE) as u64),
                    });
                }
                self.scanned = 0;
                // A forced cut mid-speech continues as a new utterance.
                self.in_speech = self.trailing_silence < END_SILENCE;
                self.speech_samples = 0;
                self.trailing_silence = 0;
            }
        }
        chunks
    }

    /// The utterance still being spoken, if any (not consumed).
    fn in_progress(&self, source: &'static str) -> Option<Chunk> {
        if !self.in_speech || self.speech_samples < MIN_SPEECH {
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
    speakers: Mutex<SpeakerClusters>,
    extractor: Mutex<Option<Extractor>>,
    last_error: Mutex<Option<String>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
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

    fn store(&self, new: Vec<LiveSegment>) {
        if new.is_empty() {
            return;
        }
        for segment in &new {
            let _ = self.app.emit("live-transcript-segment", segment.clone());
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

fn worker_loop(deps: Deps) {
    while deps.live.running.load(Ordering::SeqCst) {
        let started = Instant::now();
        let chunks = deps.pump_all();
        deps.process(chunks);
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
pub async fn live_transcript_stop(live: tauri::State<'_, Arc<LiveTranscriber>>) -> Result<(), String> {
    live.running.store(false, Ordering::SeqCst);
    let handle = live.worker.lock().map_err(|e| e.to_string())?.take();
    if let Some(handle) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || handle.join()).await;
    }
    *live.system.lock().map_err(|e| e.to_string())? = Track::default();
    *live.mic.lock().map_err(|e| e.to_string())? = Track::default();
    live.segments.lock().map_err(|e| e.to_string())?.clear();
    // A new session is a new meeting: forget the voices.
    live.speakers.lock().map_err(|e| e.to_string())?.reset();
    Ok(())
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

    let (segments, system_ratio, mic_ratio) = tauri::async_runtime::spawn_blocking(move || {
        deps.process(deps.pump_all());

        let mut provisional = Vec::new();
        let in_progress = [
            deps.live.system.lock().ok().and_then(|t| t.in_progress("system")),
            deps.live.mic.lock().ok().and_then(|t| t.in_progress("mic")),
        ];
        for chunk in in_progress.into_iter().flatten() {
            if let Ok(segments) = deps.transcribe(&chunk, false) {
                provisional.extend(segments);
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
        feed(&b, &tone(2.0, 0.2));
        assert!(track.pump(&b, "system").is_empty(), "still speaking");
        assert!(track.in_progress("system").is_some());

        feed(&b, &tone(1.0, 0.0));
        let chunks = track.pump(&b, "system");
        assert_eq!(chunks.len(), 1);
        let secs = chunks[0].samples.len() as f32 / SAMPLE_RATE as f32;
        // 2 s speech + lead-in + ~0.7 s silence, with the leading silence dropped.
        assert!((2.5..3.3).contains(&secs), "chunk was {secs}s");
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
    fn long_monologue_is_split() {
        let b = buffer();
        let mut track = Track::default();
        feed(&b, &tone(45.0, 0.2));
        let chunks = track.pump(&b, "system");
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|c| c.samples.len() <= MAX_UTTERANCE));
        assert!(track.in_progress("system").is_some());
    }
}
