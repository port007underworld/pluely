//! On-device speech-to-text with whisper.cpp. Models are downloaded on demand into
//! the app data dir and transcription reads straight from the system audio ring
//! buffer (already 16 kHz mono f32, which is what Whisper expects).

use crate::mic_audio::MicAudioState;
use crate::system_audio::{silence_ratio, SystemAudioState};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/// Buffers quieter than this are skipped: Whisper hallucinates text on silence.
const SILENT_BUFFER_RATIO: f32 = 0.97;

pub(crate) struct ModelSpec {
    id: &'static str,
    name: &'static str,
    size_mb: u32,
    pub(crate) multilingual: bool,
    description: &'static str,
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny.en",
        name: "Tiny (English)",
        size_mb: 75,
        multilingual: false,
        description: "Fastest, lowest accuracy. Good for older machines.",
    },
    ModelSpec {
        id: "base.en",
        name: "Base (English)",
        size_mb: 142,
        multilingual: false,
        description: "Recommended. Fast on any modern laptop, good accuracy.",
    },
    ModelSpec {
        id: "small.en",
        name: "Small (English)",
        size_mb: 466,
        multilingual: false,
        description: "Noticeably more accurate, needs a fast CPU or Apple Silicon.",
    },
    ModelSpec {
        id: "base",
        name: "Base (Multilingual)",
        size_mb: 142,
        multilingual: true,
        description: "Base model for non-English meetings.",
    },
    ModelSpec {
        id: "small",
        name: "Small (Multilingual)",
        size_mb: 466,
        multilingual: true,
        description: "More accurate multilingual transcription.",
    },
    ModelSpec {
        id: "large-v3-turbo-q5_0",
        name: "Large v3 Turbo (Multilingual)",
        size_mb: 547,
        multilingual: true,
        description: "Best accuracy. Apple Silicon or a strong GPU recommended.",
    },
];

pub(crate) fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown Whisper model: {}", id))
}

#[derive(Default)]
pub struct LocalSttState {
    loaded: Mutex<Option<(String, Arc<WhisperContext>)>>,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Serializes Whisper runs: live and on-demand transcription share the CPU/GPU.
    pub(crate) whisper_lock: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
    size_mb: u32,
    pub(crate) multilingual: bool,
    description: String,
    downloaded: bool,
    downloading: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// "system" = other participants (speaker output), "mic" = the user.
    pub(crate) source: &'static str,
    /// Seconds relative to the moment of capture (negative = in the past).
    pub(crate) start_offset: f32,
    pub(crate) end_offset: f32,
    pub(crate) text: String,
    /// Distinct remote voice ("Speaker 2"), when speaker separation is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) speaker: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub(crate) segments: Vec<TranscriptSegment>,
    pub(crate) text: String,
    pub(crate) silent: bool,
    pub(crate) silence_ratio: f32,
    pub(crate) mic_silence_ratio: Option<f32>,
    pub(crate) audio_seconds: f32,
    pub(crate) duration_ms: u64,
}

pub(crate) fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(format!("ggml-{}.bin", id)))
}

#[tauri::command]
pub async fn local_stt_list_models(
    app: AppHandle,
    state: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<Vec<ModelInfo>, String> {
    let downloading = state.downloads.lock().map_err(|e| e.to_string())?;
    MODELS
        .iter()
        .map(|m| {
            Ok(ModelInfo {
                id: m.id.to_string(),
                name: m.name.to_string(),
                size_mb: m.size_mb,
                multilingual: m.multilingual,
                description: m.description.to_string(),
                downloaded: model_path(&app, m.id)?.exists(),
                downloading: downloading.contains_key(m.id),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn local_stt_download_model(
    app: AppHandle,
    id: String,
    state: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<(), String> {
    spec(&id)?;
    let url = format!("{}/ggml-{}.bin", MODEL_BASE_URL, id);
    let dest = model_path(&app, &id)?;
    download_file(&app, &state, &id, &url, dest).await
}

/// Download `url` to `dest` (via a `.part` file), reporting progress on
/// "local-stt-download-progress" under `id`. Cancellable with `local_stt_cancel_download(id)`.
pub(crate) async fn download_file(
    app: &AppHandle,
    state: &LocalSttState,
    id: &str,
    url: &str,
    dest: PathBuf,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().map_err(|e| e.to_string())?;
        if downloads.contains_key(id) {
            return Ok(());
        }
        downloads.insert(id.to_string(), cancel.clone());
    }

    let result = download(app, id, url, &dest, &cancel).await;
    if let Ok(mut downloads) = state.downloads.lock() {
        downloads.remove(id);
    }

    let _ = app.emit(
        "local-stt-download-progress",
        DownloadProgress {
            id: id.to_string(),
            downloaded: 0,
            total: 0,
            done: true,
            error: result.as_ref().err().cloned(),
        },
    );
    result
}

pub(crate) fn is_downloading(state: &LocalSttState, id: &str) -> bool {
    state
        .downloads
        .lock()
        .map(|d| d.contains_key(id))
        .unwrap_or(false)
}

async fn download(
    app: &AppHandle,
    id: &str,
    url: &str,
    dest: &std::path::Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let part = dest.with_extension("part");

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    let outcome: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                return Err("Download cancelled".to_string());
            }
            let bytes = chunk.map_err(|e| format!("Download interrupted: {}", e))?;
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            downloaded += bytes.len() as u64;
            if last_emit.elapsed() > Duration::from_millis(200) {
                last_emit = Instant::now();
                let _ = app.emit(
                    "local-stt-download-progress",
                    DownloadProgress {
                        id: id.to_string(),
                        downloaded,
                        total,
                        done: false,
                        error: None,
                    },
                );
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        if total > 0 && downloaded != total {
            return Err(format!(
                "Download incomplete ({} of {} bytes)",
                downloaded, total
            ));
        }
        Ok(())
    }
    .await;

    drop(file);
    match outcome {
        Ok(()) => tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn local_stt_cancel_download(
    id: String,
    state: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<(), String> {
    if let Some(flag) = state.downloads.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn local_stt_delete_model(
    app: AppHandle,
    id: String,
    state: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<(), String> {
    spec(&id)?;
    if let Ok(mut loaded) = state.loaded.lock() {
        if loaded
            .as_ref()
            .map(|(loaded_id, _)| loaded_id == &id)
            .unwrap_or(false)
        {
            *loaded = None;
        }
    }
    let path = model_path(&app, &id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn context_for(
    app: &AppHandle,
    state: &LocalSttState,
    id: &str,
) -> Result<Arc<WhisperContext>, String> {
    let mut loaded = state.loaded.lock().map_err(|e| e.to_string())?;
    if let Some((loaded_id, ctx)) = loaded.as_ref() {
        if loaded_id == id {
            return Ok(ctx.clone());
        }
    }
    static LOG_HOOKS: std::sync::Once = std::sync::Once::new();
    LOG_HOOKS.call_once(whisper_rs::install_logging_hooks);

    let path = model_path(app, id)?;
    if !path.exists() {
        return Err(format!(
            "Whisper model '{}' is not downloaded. Download it on the Meeting page (Meeting transcription).",
            id
        ));
    }
    // Flash attention: ~1.3-1.5x faster with identical output (measured on base.en).
    let mut params = WhisperContextParameters::default();
    params.flash_attn(true);
    let ctx = WhisperContext::new_with_params(path.to_string_lossy().as_ref(), params)
    .map_err(|e| format!("Failed to load Whisper model: {}", e))?;
    let ctx = Arc::new(ctx);
    *loaded = Some((id.to_string(), ctx.clone()));
    Ok(ctx)
}

pub(crate) fn run_whisper(
    ctx: &WhisperContext,
    samples: &[f32],
    language: &str,
    source: &'static str,
) -> Result<Vec<TranscriptSegment>, String> {
    let audio_seconds = samples.len() as f32 / 16_000.0;
    let mut whisper_state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {}", e))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_n_threads(
        std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4),
    );
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    whisper_state
        .full(params, samples)
        .map_err(|e| format!("Transcription failed: {}", e))?;

    // The mic picks up typing and bumps more than meeting audio does, so it
    // needs more confidence that there's speech at all.
    let max_no_speech = if source == "mic" { 0.45 } else { 0.6 };
    // Timestamps are in centiseconds from the start of the buffer.
    Ok(whisper_state
        .as_iter()
        .filter(|segment| segment.no_speech_probability() < max_no_speech)
        .filter_map(|segment| {
            let text = segment.to_str_lossy().ok()?.trim().to_string();
            if text.is_empty() || is_hallucination(&text) {
                return None;
            }
            Some(TranscriptSegment {
                source,
                start_offset: segment.start_timestamp() as f32 / 100.0 - audio_seconds,
                end_offset: segment.end_timestamp() as f32 / 100.0 - audio_seconds,
                text,
                speaker: None,
            })
        })
        .collect())
}

fn words(text: &str) -> std::collections::HashSet<String> {
    text.split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// Whether a mic line and a meeting-audio line (times in seconds) happen at
/// the same time, as echo does. Someone repeating what was just said comes
/// after it, not during it; line timestamps are approximate, hence the tolerance.
pub(crate) fn overlaps_like_echo(mic: (f64, f64), system: (f64, f64)) -> bool {
    const TOLERANCE: f64 = 0.5;
    let overlap = mic.1.min(system.1) - mic.0.max(system.0);
    overlap + TOLERANCE >= 0.5 * (mic.1 - mic.0)
}

/// Words too common to tell two lines apart ("Yes, now is great" answering
/// "Is now still a good time?" shares "now" and "is" but isn't an echo).
const COMMON_WORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "so", "if", "then", "to", "of", "in", "on", "at", "for",
    "with", "from", "by", "as", "is", "are", "was", "were", "be", "been", "am", "i", "im", "you",
    "youre", "he", "she", "we", "they", "it", "its", "this", "that", "these", "those", "my", "your",
    "our", "their", "me", "us", "them", "do", "does", "did", "have", "has", "had", "will", "would",
    "can", "could", "should", "just", "like", "yeah", "yes", "no", "not", "now", "okay", "ok", "um",
    "uh", "well", "really", "very", "what", "how", "why", "when", "where", "which", "who", "there",
    "here", "all", "any", "some", "about", "up", "out", "get", "got", "go", "know", "think", "right",
    "sure", "oh", "great", "cool", "good", "thats", "dont", "ill", "id", "lets", "kind",
];

/// Whether a mic line is the speakers heard through the mic (no headphones):
/// most of its meaningful words were also said on the system side. Echo is
/// often transcribed partially, so this compares against the shorter line.
pub(crate) fn looks_like_echo(mic_text: &str, system_text: &str) -> bool {
    let mw = words(mic_text);
    if mw.is_empty() {
        return true;
    }
    let content = |w: std::collections::HashSet<String>| -> std::collections::HashSet<String> {
        w.into_iter().filter(|w| !COMMON_WORDS.contains(&w.as_str())).collect()
    };
    let mc = content(mw);
    let sc = content(words(system_text));
    // Nothing distinctive to compare ("Yeah, okay."): keep it.
    if mc.is_empty() {
        return false;
    }
    let shared = mc.intersection(&sc).count();
    let smaller = mc.len().min(sc.len()).max(1);
    let needed = if mc.len() == 1 { 1 } else { 2 };
    shared >= needed && shared as f32 / smaller as f32 >= 0.6
}

/// Without headphones the mic hears the speakers, so "You" would repeat what
/// "Them" said. Drop mic segments that overlap in time and mostly share words.
pub(crate) fn remove_echo(
    mic: Vec<TranscriptSegment>,
    system: &[TranscriptSegment],
) -> Vec<TranscriptSegment> {
    mic.into_iter()
        .filter(|m| {
            !system.iter().any(|s| {
                overlaps_like_echo(
                    (m.start_offset as f64, m.end_offset as f64),
                    (s.start_offset as f64, s.end_offset as f64),
                ) && looks_like_echo(&m.text, &s.text)
            }) && !words(&m.text).is_empty()
        })
        .collect()
}

/// Text Whisper produces from noise or silence rather than speech: bracketed
/// sound tags ("[Music]", "(keyboard clicking)"), music notes, and a few
/// phrases it's known to invent.
pub(crate) fn is_hallucination(text: &str) -> bool {
    let trimmed = text.trim();
    let tag_only = trimmed
        .split(|c| matches!(c, '[' | ']' | '(' | ')' | '*' | '♪' | '♫'))
        .enumerate()
        .all(|(i, part)| i % 2 == 1 || part.trim().chars().all(|c| !c.is_alphanumeric()));
    if tag_only || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return true;
    }
    let normalized: String = trimmed
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        normalized.as_str(),
        "you"
            | "thank you"
            | "thank you very much"
            | "thanks for watching"
            | "thank you for watching"
            | "thanks for watching and see you next time"
            | "please subscribe"
            | "subscribe"
            | "bye"
            | "bye bye"
    )
}

/// Transcribe the last `seconds` of system audio (and the mic, when it is being
/// captured) on-device, returning time-ordered segments labelled by source.
#[tauri::command]
pub async fn local_stt_transcribe_recent(
    app: AppHandle,
    model_id: String,
    seconds: Option<u32>,
    language: Option<String>,
    audio: tauri::State<'_, Arc<SystemAudioState>>,
    mic: tauri::State<'_, Arc<MicAudioState>>,
    state: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<TranscriptResult, String> {
    let model = spec(&model_id)?;
    let system_samples = audio.recent_samples(seconds);
    let mic_samples = if mic.buffer.is_recording() {
        mic.buffer.recent_samples(seconds).ok()
    } else {
        None
    };
    if system_samples.is_err() && mic_samples.is_none() {
        return Err(system_samples.err().unwrap_or_default());
    }
    let system_samples = system_samples.ok();

    let system_ratio = system_samples.as_deref().map(silence_ratio).unwrap_or(1.0);
    let mic_ratio = mic_samples.as_deref().map(silence_ratio);
    let audio_seconds = system_samples
        .as_ref()
        .or(mic_samples.as_ref())
        .map(|s| s.len() as f32 / 16_000.0)
        .unwrap_or(0.0);

    let system_samples = system_samples.filter(|_| system_ratio < SILENT_BUFFER_RATIO);
    let mic_samples = mic_samples.filter(|_| mic_ratio.unwrap_or(1.0) < SILENT_BUFFER_RATIO);
    let result = |segments: Vec<TranscriptSegment>, duration_ms: u64| {
        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        TranscriptResult {
            segments,
            text,
            silent: system_ratio >= SILENT_BUFFER_RATIO,
            silence_ratio: system_ratio,
            mic_silence_ratio: mic_ratio,
            audio_seconds,
            duration_ms,
        }
    };

    if system_samples.is_none() && mic_samples.is_none() {
        return Ok(result(Vec::new(), 0));
    }

    let language = if model.multilingual {
        language
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string())
    } else {
        "en".to_string()
    };

    let started = Instant::now();
    let state = state.inner().clone();
    let segments = tauri::async_runtime::spawn_blocking(move || {
        let ctx = context_for(&app, &state, &model_id)?;
        let _guard = state.whisper_lock.lock().map_err(|e| e.to_string())?;
        let system = match system_samples {
            Some(samples) => run_whisper(&ctx, &samples, &language, "system")?,
            None => Vec::new(),
        };
        let mic = match mic_samples {
            Some(samples) => remove_echo(run_whisper(&ctx, &samples, &language, "mic")?, &system),
            None => Vec::new(),
        };
        let mut all: Vec<TranscriptSegment> = system.into_iter().chain(mic).collect();
        all.sort_by(|a, b| a.start_offset.total_cmp(&b.start_offset));
        Ok::<_, String>(all)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result(segments, started.elapsed().as_millis() as u64))
}

/// Silence analysis without transcription, so cloud/raw modes can warn too.
#[tauri::command]
pub async fn system_audio_silence_ratio(
    seconds: Option<u32>,
    audio: tauri::State<'_, Arc<SystemAudioState>>,
) -> Result<f32, String> {
    Ok(silence_ratio(&audio.recent_samples(seconds)?))
}

#[cfg(test)]
mod tests {
    #[test]
    fn whisper_noise_phrases_are_dropped() {
        for noise in ["[Music]", "(keyboard clicking)", "♪ ♪", "*sigh*", " Thank you. ", "you", "Thanks for watching!", "..."] {
            assert!(is_hallucination(noise), "{noise}");
        }
        for speech in ["Thank you for the demo, that was helpful.", "Hello (laughs) nice to meet you", "Okay.", "Yes"] {
            assert!(!is_hallucination(speech), "{speech}");
        }
    }

    #[test]
    fn echo_is_matched_on_the_shorter_line() {
        // A partial echo of what the other side said.
        assert!(looks_like_echo("how would your system behave", "How would your system behave if an entire region went down?"));
        // The user answering something different at the same time.
        assert!(!looks_like_echo("we fail over to the next region in seconds", "How would your system behave if a region went down?"));
        assert!(looks_like_echo("...", "anything"));
    }

    use super::*;
    use crate::system_audio::encode_wav_pcm16;

    fn seg(source: &'static str, start: f32, end: f32, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            source,
            start_offset: start,
            end_offset: end,
            text: text.to_string(),
            speaker: None,
        }
    }

    #[test]
    fn echo_of_speaker_audio_is_dropped_but_own_speech_kept() {
        let system = vec![seg(
            "system",
            -20.0,
            -15.0,
            "Can you walk me through the design?",
        )];
        let mic = vec![
            seg("mic", -19.5, -15.2, "can you walk me through the design"),
            seg("mic", -10.0, -5.0, "Sure, it starts with a queue."),
        ];
        let kept = remove_echo(mic, &system);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].text, "Sure, it starts with a queue.");
    }

    #[test]
    fn repeating_someone_right_after_them_is_not_echo() {
        // Real case: two people introducing themselves with the same sentence.
        let system = vec![seg("system", -20.0, -16.0, "I've been here for about two and a half years.")];
        let mic = vec![seg("mic", -24.0, -20.2, "I've been here for about six and a half years.")];
        assert_eq!(remove_echo(mic, &system).len(), 1);
    }

    #[test]
    fn a_reply_repeating_common_words_is_not_echo() {
        // Real case: answering "Is now still a good time for you?".
        assert!(!looks_like_echo("Yes, now is great.", "Awesome, is now still a good time for you?"));
        assert!(!looks_like_echo("Yeah, okay.", "Okay, so what do you think?"));
        assert!(looks_like_echo(
            "So Parsh Fax is going to take that list of facts.",
            "Parsh Facts is going to take that list of facts and like return a table."
        ));
        assert!(looks_like_echo("clear, readable implementation.", "I'd like you to focus on clear readable implementation."));
    }

    #[test]
    fn same_words_far_apart_in_time_are_not_echo() {
        let system = vec![seg("system", -28.0, -26.0, "yes exactly")];
        let mic = vec![seg("mic", -5.0, -3.0, "yes exactly")];
        assert_eq!(remove_echo(mic, &system).len(), 1);
    }

    #[test]
    fn silence_ratio_detects_silence_and_tone() {
        assert!(silence_ratio(&vec![0.0; 16_000]) > 0.99);
        let tone: Vec<f32> = (0..16_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 16_000.0).sin() * 0.2)
            .collect();
        assert!(silence_ratio(&tone) < 0.01);
    }

    #[test]
    fn wav_header_is_valid() {
        let wav = encode_wav_pcm16(&vec![0.5; 320]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(wav.len(), 44 + 640);
    }

    /// WHISPER_TEST_MODEL=/path/ggml-tiny.en.bin WHISPER_TEST_WAV=/path/jfk.wav \
    /// cargo test transcribes_real_speech -- --ignored --nocapture
    #[test]
    #[ignore]
    fn transcribes_real_speech() {
        let model = std::env::var("WHISPER_TEST_MODEL").expect("WHISPER_TEST_MODEL");
        let wav =
            std::fs::read(std::env::var("WHISPER_TEST_WAV").expect("WHISPER_TEST_WAV")).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let samples: Vec<f32> = wav[data..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
            .collect();

        let ctx =
            WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let started = Instant::now();
        let segments = run_whisper(&ctx, &samples, "en", "system").unwrap();
        let elapsed = started.elapsed();
        for s in &segments {
            println!("[{:.1} .. {:.1}] {}", s.start_offset, s.end_offset, s.text);
        }
        println!(
            "{:.1}s of audio in {:?}",
            samples.len() as f32 / 16_000.0,
            elapsed
        );

        let text = segments
            .iter()
            .map(|s| s.text.to_lowercase())
            .collect::<String>();
        assert!(text.contains("ask not what your country can do for you"));
        assert!(segments
            .iter()
            .all(|s| s.start_offset <= 0.0 && s.end_offset <= 0.1));
    }
}

#[cfg(test)]
mod bench {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    fn read_wav(path: &str) -> Vec<f32> {
        let wav = std::fs::read(path).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        wav[data..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect()
    }

    fn run(ctx: &WhisperContext, samples: &[f32], audio_ctx: bool) -> (String, std::time::Duration) {
        let mut state = ctx.create_state().unwrap();
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_language(Some("en"));
        p.set_n_threads(8);
        p.set_no_context(true);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_special(false);
        p.set_print_timestamps(false);
        if audio_ctx {
            let secs = samples.len() as f32 / 16_000.0;
            p.set_audio_ctx(((secs * 50.0) as i32 + 128).min(1500));
        }
        let t = std::time::Instant::now();
        state.full(p, samples).unwrap();
        let text = state
            .as_iter()
            .map(|s| s.to_str_lossy().unwrap().to_string())
            .collect::<String>();
        (text.trim().to_string(), t.elapsed())
    }

    /// WHISPER_TEST_MODEL=... WHISPER_TEST_WAV=... cargo test --release whisper_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn whisper_speed() {
        let model = std::env::var("WHISPER_TEST_MODEL").unwrap();
        let jfk = read_wav(&std::env::var("WHISPER_TEST_WAV").unwrap());
        let short: Vec<f32> = jfk[..16_000 * 3].to_vec();
        let long: Vec<f32> = jfk.iter().chain(jfk.iter()).copied().collect();

        for flash in [false, true] {
            let mut cp = WhisperContextParameters::default();
            cp.flash_attn(flash);
            let ctx = WhisperContext::new_with_params(&model, cp).unwrap();
            run(&ctx, &short, false); // warm-up (Metal shader compile)
            for audio_ctx in [false, true] {
                if !flash && audio_ctx {
                    continue;
                }
                for (name, s) in [("3s", &short), ("11s", &jfk), ("22s", &long)] {
                    let (text, t) = run(&ctx, s, audio_ctx);
                    println!(
                        "flash={flash:<5} audio_ctx={audio_ctx:<5} {name:>4}: {:>6.0} ms  {}",
                        t.as_secs_f64() * 1000.0,
                        &text.chars().take(60).collect::<String>()
                    );
                }
            }
        }
    }
}
