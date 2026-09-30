//! Replays recorded audio through the live transcriber, as a real meeting would
//! feed it, and writes every line it produces. For finding edge cases that
//! only show up with real speech (merged turns, split sentences, echo,
//! noise, speaker mix-ups). Not run by default:
//!
//!   REPLAY_SYSTEM=meeting.wav [REPLAY_MIC=mic.wav] [REPLAY_OUT=lines.json] \
//!     cargo test replay_recording -- --ignored --nocapture
//!
//! REPLAY_EMBEDDINGS=path also writes each voice embedding with its time
//! range, for tuning speaker separation offline.
//!
//! WAVs must be 16 kHz mono 16-bit PCM. The Whisper model defaults to the
//! app's base.en; REPLAY_MODEL overrides it. Speaker separation runs when the
//! speaker model is downloaded (macOS).

use super::*;
use crate::local_stt::run_whisper;
use std::path::{Path, PathBuf};
use whisper_rs::{WhisperContext, WhisperContextParameters};

const STEP: usize = SAMPLE_RATE / 4; // 250 ms, like the worker's poll
const START_MS: u64 = 1_800_000_000_000;

fn read_wav(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(&bytes[0..4], b"RIFF", "{} is not a WAV file", path.display());
    let mut i = 12;
    let (mut channels, mut rate, mut bits, mut data) = (0u16, 0u32, 0u16, None);
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
        match id {
            b"fmt " => {
                channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
                rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
            }
            b"data" => data = Some(body),
            _ => {}
        }
        i += 8 + len + (len & 1);
    }
    assert!(
        channels == 1 && rate == 16_000 && bits == 16,
        "{}: need 16 kHz mono 16-bit, got {rate} Hz, {channels} ch, {bits} bit",
        path.display()
    );
    data.expect("no data chunk")
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0)
        .collect()
}

fn app_data() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap())
        .join("Library/Application Support/com.srikanthnani.runningbord/whisper-models")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayLine {
    source: &'static str,
    speaker: Option<String>,
    /// Seconds into the recording.
    start: f32,
    end: f32,
    /// When the line would reach the app (after the utterance closed; mic
    /// lines also wait out the echo hold). Whisper's own time isn't included.
    arrives: f32,
    whisper_ms: u128,
    text: String,
}

#[test]
#[ignore]
fn replay_recording() {
    let Ok(system_path) = std::env::var("REPLAY_SYSTEM") else {
        eprintln!("set REPLAY_SYSTEM=path.wav");
        return;
    };
    let system_audio = read_wav(Path::new(&system_path));
    let mic_audio = std::env::var("REPLAY_MIC").ok().map(|p| read_wav(Path::new(&p)));
    let model = std::env::var("REPLAY_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app_data().join("ggml-base.en.bin"));
    let mut params = WhisperContextParameters::default();
    params.flash_attn(true);
    let ctx = WhisperContext::new_with_params(model.to_string_lossy().as_ref(), params)
        .expect("load Whisper model");
    let mut extractor = Extractor::load_path(&app_data().join("wespeaker_en_voxceleb_resnet34_LM.onnx")).ok();
    let mut speakers = SpeakerClusters::default();
    eprintln!("speaker separation: {}", if extractor.is_some() { "on" } else { "off" });

    let system = SystemAudioState::new();
    system.set_recording(true);
    let mic = SystemAudioState::new();
    mic.set_recording(true);
    let (mut system_track, mut mic_track) = (Track::default(), Track::default());

    let mut committed: Vec<LiveSegment> = Vec::new();
    let mut held: Vec<(LiveSegment, u128)> = Vec::new();
    let mut lines: Vec<ReplayLine> = Vec::new();
    let mut embeddings: Vec<(f32, f32, Vec<f32>)> = Vec::new();
    let rel = |ms: u64| (ms.saturating_sub(START_MS)) as f32 / 1000.0;
    let mut record = |segment: &LiveSegment, arrives: u64, whisper_ms: u128, lines: &mut Vec<ReplayLine>| {
        lines.push(ReplayLine {
            source: segment.source,
            speaker: segment.speaker.clone(),
            start: rel(segment.start_ms),
            end: rel(segment.end_ms),
            arrives: rel(arrives),
            whisper_ms,
            text: segment.text.clone(),
        })
    };

    // Two seconds of silence at the end so the last utterance closes.
    let total = system_audio.len().max(mic_audio.as_ref().map_or(0, |m| m.len())) + 2 * SAMPLE_RATE;
    let slice = |audio: &[f32], from: usize| -> Vec<f32> {
        (from..from + STEP).map(|i| audio.get(i).copied().unwrap_or(0.0)).collect()
    };
    let mut pos = 0;
    while pos < total {
        let now = START_MS + (pos + STEP) as u64 * 1000 / SAMPLE_RATE as u64;
        system.push_samples_realtime(&slice(&system_audio, pos));
        if let Some(m) = &mic_audio {
            mic.push_samples_realtime(&slice(m, pos));
        }
        pos += STEP;

        let mut chunks = system_track.pump_at(&system, "system", now);
        if mic_audio.is_some() {
            chunks.extend(mic_track.pump_at(&mic, "mic", now));
        }
        for chunk in chunks {
            let started = Instant::now();
            let segments = run_whisper(&ctx, &chunk.samples, "en", chunk.source).expect("whisper");
            let whisper_ms = started.elapsed().as_millis();
            let chunk_start = rel(chunk.end_ms) - chunk.samples.len() as f32 / SAMPLE_RATE as f32;
            let labels = match extractor.as_mut() {
                Some(extractor) if chunk.source == "system" && !segments.is_empty() => label_speakers(
                    &chunk,
                    &segments,
                    |samples| {
                        let embedding = extractor.embed(samples).ok();
                        if let Some(e) = &embedding {
                            // Where these samples sit in the recording, for REPLAY_EMBEDDINGS.
                            let offset = samples.as_ptr() as usize - chunk.samples.as_ptr() as usize;
                            let start = chunk_start + (offset / 4) as f32 / SAMPLE_RATE as f32;
                            embeddings.push((start, start + samples.len() as f32 / SAMPLE_RATE as f32, e.clone()));
                        }
                        embedding
                    },
                    &mut speakers,
                    true,
                ),
                _ => vec![None; segments.len()],
            };
            for segment in live_segments(&chunk, segments, labels) {
                if segment.source == "mic" {
                    held.push((segment, whisper_ms));
                } else {
                    record(&segment, now, whisper_ms, &mut lines);
                    committed.push(segment);
                }
            }
        }
        // Mic lines: drop echo, release once the meeting audio has caught up.
        let settled = system_track.settled_until();
        held.retain(|(segment, whisper_ms)| {
            if is_echo(segment, &committed) {
                eprintln!("  (echo dropped) {}", segment.text);
                return false;
            }
            if echo_check_done(segment, settled, now) {
                record(segment, now, *whisper_ms, &mut lines);
                return false;
            }
            true
        });
    }

    lines.sort_by(|a, b| a.start.total_cmp(&b.start));
    for l in &lines {
        eprintln!(
            "{:>6.1}-{:>6.1}s  +{:.1}s  {:<3} {:<10} {}",
            l.start,
            l.end,
            l.arrives - l.end,
            if l.source == "mic" { "mic" } else { "sys" },
            l.speaker.as_deref().unwrap_or(if l.source == "mic" { "You" } else { "Them" }),
            l.text
        );
    }
    if let Ok(out) = std::env::var("REPLAY_EMBEDDINGS") {
        std::fs::write(&out, serde_json::to_string(&embeddings).unwrap()).unwrap();
        eprintln!("wrote {} embeddings to {out}", embeddings.len());
    }
    if let Ok(out) = std::env::var("REPLAY_OUT") {
        std::fs::write(&out, serde_json::to_string_pretty(&lines).unwrap()).unwrap();
        eprintln!("wrote {out}");
    }
}
