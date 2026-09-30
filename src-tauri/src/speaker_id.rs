//! Tells remote speakers apart ("Speaker 1", "Speaker 2", ...) by clustering
//! voice embeddings of each live-transcribed utterance. macOS only for now; on
//! other platforms the commands report `supported: false`.

use serde::Serialize;
use std::sync::Arc;
use tauri::AppHandle;

use crate::local_stt::{download_file, is_downloading, models_dir, LocalSttState};

pub const SPEAKER_MODEL_ID: &str = "speaker-wespeaker-resnet34";
const SPEAKER_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx";
const SPEAKER_MODEL_SIZE_MB: u32 = 26;

pub fn model_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(models_dir(app)?.join("wespeaker_en_voxceleb_resnet34_LM.onnx"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerModelStatus {
    supported: bool,
    downloaded: bool,
    downloading: bool,
    size_mb: u32,
}

#[tauri::command]
pub async fn speaker_model_status(
    app: AppHandle,
    stt: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<SpeakerModelStatus, String> {
    Ok(SpeakerModelStatus {
        supported: cfg!(target_os = "macos"),
        downloaded: model_path(&app)?.exists(),
        downloading: is_downloading(&stt, SPEAKER_MODEL_ID),
        size_mb: SPEAKER_MODEL_SIZE_MB,
    })
}

#[tauri::command]
pub async fn speaker_model_download(
    app: AppHandle,
    stt: tauri::State<'_, Arc<LocalSttState>>,
) -> Result<(), String> {
    let dest = model_path(&app)?;
    download_file(&app, &stt, SPEAKER_MODEL_ID, SPEAKER_MODEL_URL, dest).await
}

#[tauri::command]
pub async fn speaker_model_delete(app: AppHandle) -> Result<(), String> {
    let path = model_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Tuned on twelve recorded interviews. The speaker model scores two
/// different people anywhere from ~0.5 (a man and a woman) to ~0.85 (two
/// similar voices on compressed audio), so a lower threshold merges people in
/// some calls. Erring high splits one person into several labels instead,
/// which naming them the same in People undoes; merged people can't be undone.
const SAME_SPEAKER: f32 = 0.80;
/// Short utterances give noisy embeddings: only attach them to a clear match.
const SHORT_MATCH: f32 = 0.70;
const MIN_RELIABLE_SECONDS: f32 = 1.5;
/// A voice that matches nobody becomes a new speaker only after this many
/// matching utterances. One-off odd audio (a laugh, music, a bad line) would
/// otherwise start a new "Speaker N" each time.
const CONFIRM_UTTERANCES: usize = 3;
const MAX_CANDIDATES: usize = 6;
const MAX_SPEAKERS: usize = 8;

fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Running-mean centroid of normalized embeddings.
struct Cluster {
    centroid: Vec<f32>,
    count: usize,
}

impl Cluster {
    fn new(embedding: Vec<f32>) -> Self {
        Self { centroid: embedding, count: 1 }
    }

    fn add(&mut self, embedding: &[f32]) {
        let n = self.count as f32;
        self.centroid
            .iter_mut()
            .zip(embedding)
            .for_each(|(c, e)| *c = (*c * n + e) / (n + 1.0));
        normalize(&mut self.centroid);
        self.count += 1;
    }
}

fn best_match(clusters: &[Cluster], embedding: &[f32]) -> Option<(usize, f32)> {
    clusters
        .iter()
        .enumerate()
        .map(|(i, c)| (i, dot(&c.centroid, embedding)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// Online clustering of voices into "Speaker 1", "Speaker 2"...
#[derive(Default)]
pub struct SpeakerClusters {
    speakers: Vec<Cluster>,
    /// Voices heard but not (yet) confirmed as a new speaker.
    candidates: Vec<Cluster>,
}

impl SpeakerClusters {
    /// Label for an utterance's embedding. `learn` = update/create clusters
    /// (false for provisional, still-in-progress audio).
    pub fn assign(&mut self, mut embedding: Vec<f32>, seconds: f32, learn: bool) -> Option<String> {
        normalize(&mut embedding);
        let reliable = seconds >= MIN_RELIABLE_SECONDS;
        let label = |i: usize| Some(format!("Speaker {}", i + 1));

        let threshold = if reliable { SAME_SPEAKER } else { SHORT_MATCH };
        if let Some((i, score)) = best_match(&self.speakers, &embedding) {
            if score >= threshold {
                if learn && reliable {
                    self.speakers[i].add(&embedding);
                }
                return label(i);
            }
        }
        // Too short to judge a new voice by, or just a preview.
        if !(learn && reliable) {
            return None;
        }
        if self.speakers.is_empty() {
            self.speakers.push(Cluster::new(embedding));
            return label(0);
        }
        match best_match(&self.candidates, &embedding) {
            Some((i, score)) if score >= SAME_SPEAKER => {
                self.candidates[i].add(&embedding);
                if self.candidates[i].count >= CONFIRM_UTTERANCES && self.speakers.len() < MAX_SPEAKERS {
                    self.speakers.push(self.candidates.remove(i));
                    return label(self.speakers.len() - 1);
                }
            }
            _ => {
                self.candidates.push(Cluster::new(embedding));
                if self.candidates.len() > MAX_CANDIDATES {
                    self.candidates.remove(0);
                }
            }
        }
        // Not attributed until the voice is confirmed.
        None
    }

    pub fn reset(&mut self) {
        self.speakers.clear();
        self.candidates.clear();
    }
}

#[cfg(target_os = "macos")]
pub struct Extractor(sherpa_rs::speaker_id::EmbeddingExtractor);

#[cfg(target_os = "macos")]
impl Extractor {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        Self::load_path(&model_path(app)?)
    }

    pub fn load_path(path: &std::path::Path) -> Result<Self, String> {
        if !path.exists() {
            return Err("Speaker model is not downloaded".to_string());
        }
        sherpa_rs::speaker_id::EmbeddingExtractor::new(sherpa_rs::speaker_id::ExtractorConfig {
            model: path.to_string_lossy().to_string(),
            provider: None,
            num_threads: Some(2),
            debug: false,
        })
        .map(Extractor)
        .map_err(|e| format!("Failed to load speaker model: {}", e))
    }

    pub fn embed(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
        self.0
            .compute_speaker_embedding(samples.to_vec(), 16_000)
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub struct Extractor;

#[cfg(not(target_os = "macos"))]
impl Extractor {
    pub fn load(_app: &AppHandle) -> Result<Self, String> {
        Err("Speaker separation is only available on macOS".to_string())
    }

    pub fn embed(&mut self, _samples: &[f32]) -> Result<Vec<f32>, String> {
        Err("Speaker separation is only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(seed: f32, jitter: f32) -> Vec<f32> {
        (0..16).map(|i| ((i as f32 + seed) * 1.7).sin() + jitter * (i as f32).cos()).collect()
    }

    #[test]
    fn clusters_same_voice_together_and_new_voice_apart() {
        let mut c = SpeakerClusters::default();
        assert_eq!(c.assign(voice(0.0, 0.0), 3.0, true).as_deref(), Some("Speaker 1"));
        assert_eq!(c.assign(voice(0.0, 0.05), 3.0, true).as_deref(), Some("Speaker 1"));
        // A new voice is only named once it's been heard a few times.
        assert_eq!(c.assign(voice(5.0, 0.0), 3.0, true), None);
        assert_eq!(c.assign(voice(5.0, 0.03), 3.0, true), None);
        assert_eq!(c.assign(voice(5.0, 0.05), 3.0, true).as_deref(), Some("Speaker 2"));
        assert_eq!(c.assign(voice(5.0, 0.02), 3.0, true).as_deref(), Some("Speaker 2"));
        assert_eq!(c.assign(voice(0.0, 0.02), 3.0, true).as_deref(), Some("Speaker 1"));
    }

    #[test]
    fn a_one_off_voice_never_becomes_a_speaker() {
        let mut c = SpeakerClusters::default();
        assert_eq!(c.assign(voice(0.0, 0.0), 3.0, true).as_deref(), Some("Speaker 1"));
        assert_eq!(c.assign(voice(9.0, 0.0), 3.0, true), None);
        for _ in 0..5 {
            assert_eq!(c.assign(voice(0.0, 0.03), 3.0, true).as_deref(), Some("Speaker 1"));
        }
        assert_eq!(c.speakers.len(), 1);
    }

    #[test]
    fn short_or_provisional_utterances_never_create_speakers() {
        let mut c = SpeakerClusters::default();
        assert_eq!(c.assign(voice(0.0, 0.0), 0.8, true), None);
        assert_eq!(c.assign(voice(0.0, 0.0), 3.0, false), None);
        assert!(c.speakers.is_empty() && c.candidates.is_empty());
    }

    /// Real voices: WHISPER_TEST_DIR with spk.onnx and a1/a2 (voice A), b1/b2 (voice B), c1 (voice C).
    /// cargo test --release real_voices_are_separated -- --ignored --nocapture
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_voices_are_separated() {
        let dir = std::env::var("WHISPER_TEST_DIR").expect("WHISPER_TEST_DIR");
        let read = |name: &str| {
            let wav = std::fs::read(format!("{dir}/{name}.wav")).unwrap();
            let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
            wav[data..]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect::<Vec<f32>>()
        };
        let mut ex = Extractor(
            sherpa_rs::speaker_id::EmbeddingExtractor::new(sherpa_rs::speaker_id::ExtractorConfig {
                model: format!("{dir}/spk.onnx"),
                provider: None,
                num_threads: Some(2),
                debug: false,
            })
            .unwrap(),
        );
        let mut clusters = SpeakerClusters::default();
        let labels: Vec<Option<String>> = ["a1", "b1", "a2", "c1", "b2"]
            .iter()
            .map(|n| {
                let samples = read(n);
                let seconds = samples.len() as f32 / 16_000.0;
                let label = clusters.assign(ex.embed(&samples).unwrap(), seconds, true);
                println!("{n}: {label:?}");
                label
            })
            .collect();
        assert_eq!(labels[0], labels[2], "same voice A");
        assert_eq!(labels[1], labels[4], "same voice B");
        assert_ne!(labels[0], labels[1]);
        assert_ne!(labels[3], labels[0]);
        assert_ne!(labels[3], labels[1]);
    }
}
