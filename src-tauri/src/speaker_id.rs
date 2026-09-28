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

/// Same voice across utterances scores ~0.9; different voices ~0.4-0.7.
const SAME_SPEAKER: f32 = 0.75;
/// Short utterances give noisy embeddings: only attach them to a clear match.
const SHORT_MATCH: f32 = 0.65;
const MIN_RELIABLE_SECONDS: f32 = 1.5;
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

/// Online clustering over normalized embeddings (running-mean centroids).
#[derive(Default)]
pub struct SpeakerClusters {
    centroids: Vec<(Vec<f32>, usize)>,
}

impl SpeakerClusters {
    /// Label for an utterance's embedding. `learn` = update/create clusters
    /// (false for provisional, still-in-progress audio).
    pub fn assign(&mut self, mut embedding: Vec<f32>, seconds: f32, learn: bool) -> Option<String> {
        normalize(&mut embedding);
        let best = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, (c, _))| (i, dot(c, &embedding)))
            .max_by(|a, b| a.1.total_cmp(&b.1));

        let reliable = seconds >= MIN_RELIABLE_SECONDS;
        let threshold = if reliable { SAME_SPEAKER } else { SHORT_MATCH };
        match best {
            Some((i, score)) if score >= threshold => {
                if learn && reliable {
                    let (centroid, count) = &mut self.centroids[i];
                    let n = *count as f32;
                    centroid
                        .iter_mut()
                        .zip(&embedding)
                        .for_each(|(c, e)| *c = (*c * n + e) / (n + 1.0));
                    normalize(centroid);
                    *count += 1;
                }
                Some(format!("Speaker {}", i + 1))
            }
            _ if learn && reliable && self.centroids.len() < MAX_SPEAKERS => {
                self.centroids.push((embedding, 1));
                Some(format!("Speaker {}", self.centroids.len()))
            }
            // Too short to judge, or too many voices: fall back to the generic label.
            _ => None,
        }
    }

    pub fn reset(&mut self) {
        self.centroids.clear();
    }
}

#[cfg(target_os = "macos")]
pub struct Extractor(sherpa_rs::speaker_id::EmbeddingExtractor);

#[cfg(target_os = "macos")]
impl Extractor {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = model_path(app)?;
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
        assert_eq!(c.assign(voice(5.0, 0.0), 3.0, true).as_deref(), Some("Speaker 2"));
        assert_eq!(c.assign(voice(5.0, 0.05), 3.0, true).as_deref(), Some("Speaker 2"));
    }

    #[test]
    fn short_or_provisional_utterances_never_create_speakers() {
        let mut c = SpeakerClusters::default();
        assert_eq!(c.assign(voice(0.0, 0.0), 0.8, true), None);
        assert_eq!(c.assign(voice(0.0, 0.0), 3.0, false), None);
        assert!(c.centroids.is_empty());
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
