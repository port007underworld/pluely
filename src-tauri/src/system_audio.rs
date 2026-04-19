//! Passive background system audio daemon: records last N seconds of system audio
//! and returns them as Opus/OGG base64 when requested (e.g. on screenshot shortcut).
//!
//! On macOS 14.2+: uses Core Audio Process Tap API (no BlackHole required).
//! On Linux (Ubuntu 24+): uses PipeWire sink monitor capture.
//! On Windows 10/11: uses WASAPI loopback capture via cpal.
//! On other platforms: returns "unsupported".

use base64::Engine;
use serde::Serialize;
use std::io::Cursor;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

/// Output sample rate for Opus encoding (speech-optimized).
const OUTPUT_SAMPLE_RATE: u32 = 16000;
/// Output is mono.
const OUTPUT_CHANNELS: u16 = 1;

/// Max buffer we allocate (seconds). Actual used length is set on start.
const MAX_BUFFER_SECONDS: u32 = 300;

/// Shared state for the system audio ring buffer and daemon control.
pub struct SystemAudioState {
    /// Ring buffer: physical capacity = MAX_BUFFER_SECONDS * OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS.
    /// Logical length (samples to return) = buffer_seconds * OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS.
    ring: Mutex<(Vec<f32>, usize)>,
    capacity: usize,
    /// Number of samples to return in get_recent (logical_seconds * rate * ch).
    logical_len: Mutex<usize>,
    /// Total number of samples successfully written to the ring buffer since
    /// the current capture session started.
    written_samples: AtomicUsize,
    /// Whether the daemon is currently recording.
    recording: AtomicBool,
    /// Join handle for the capture thread (macOS only).
    #[allow(dead_code)]
    capture_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl SystemAudioState {
    pub fn new() -> Self {
        let capacity = (MAX_BUFFER_SECONDS as usize)
            .saturating_mul(OUTPUT_SAMPLE_RATE as usize)
            .saturating_mul(OUTPUT_CHANNELS as usize);
        let capacity = capacity.max(1);
        let default_seconds = 30u32;
        let logical_len = (default_seconds as usize)
            .saturating_mul(OUTPUT_SAMPLE_RATE as usize)
            .saturating_mul(OUTPUT_CHANNELS as usize)
            .min(capacity);
        Self {
            ring: Mutex::new((vec![0.0; capacity], 0)),
            capacity,
            logical_len: Mutex::new(logical_len),
            written_samples: AtomicUsize::new(0),
            recording: AtomicBool::new(false),
            capture_handle: Mutex::new(None),
        }
    }

    /// Clear ring state at session start so short recordings don't include
    /// stale or zero-padded history from previous sessions.
    pub fn reset_capture_state(&self) {
        if let Ok(mut ring) = self.ring.lock() {
            let (buf, idx) = &mut *ring;
            buf.fill(0.0);
            *idx = 0;
        }
        self.written_samples.store(0, Ordering::SeqCst);
    }

    /// Set logical buffer length (samples to keep/return) for next start. Call before start.
    pub fn set_buffer_seconds(&self, buffer_seconds: u32) {
        let len = (buffer_seconds as usize)
            .saturating_mul(OUTPUT_SAMPLE_RATE as usize)
            .saturating_mul(OUTPUT_CHANNELS as usize)
            .min(self.capacity)
            .max(1);
        if let Ok(mut l) = self.logical_len.lock() {
            *l = len;
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    /// Store the capture thread handle so it can be joined on stop (macOS fallback).
    pub fn store_capture_handle(&self, handle: thread::JoinHandle<()>) {
        if let Ok(mut h) = self.capture_handle.lock() {
            *h = Some(handle);
        }
    }

    /// Push 16 kHz mono samples from a real-time audio thread. Uses try_lock to avoid
    /// blocking the audio IO thread. Drops samples if the mutex is held
    /// (e.g. during get_recent_base64), which is acceptable for a background
    /// audio capture ring buffer.
    pub fn push_samples_realtime(&self, samples: &[f32]) {
        if !self.recording.load(Ordering::Relaxed) {
            return;
        }
        if samples.is_empty() {
            return;
        }
        if let Ok(mut ring) = self.ring.try_lock() {
            let (buf, idx) = &mut *ring;
            let cap = self.capacity;
            if cap == 0 {
                return;
            }

            // If the incoming chunk is larger than capacity, keep only the tail
            // that fits in the ring buffer.
            let src = if samples.len() > cap {
                &samples[samples.len() - cap..]
            } else {
                samples
            };

            let start = *idx;
            let len = src.len();

            if start + len <= cap {
                buf[start..start + len].copy_from_slice(src);
                *idx = (start + len) % cap;
            } else {
                let first_part = cap - start;
                buf[start..cap].copy_from_slice(&src[..first_part]);
                buf[..len - first_part].copy_from_slice(&src[first_part..]);
                *idx = len - first_part;
            }

            self.written_samples.fetch_add(len, Ordering::Relaxed);
        }
    }

    /// Snapshot the last N seconds (logical_len) from the ring buffer,
    /// encode as Opus inside an OGG container,
    /// and return the result as a base64 string.
    pub fn get_recent_base64(&self) -> Result<String, String> {
        let logical_len = *self.logical_len.lock().map_err(|e| e.to_string())?;
        let captured = self.written_samples.load(Ordering::Acquire);
        let available_len = logical_len.min(captured.min(self.capacity));

        if available_len == 0 {
            return Err("No audio recorded yet".to_string());
        }

        let ordered = {
            // Lock, copy only the requested slice, and unlock immediately.
            let ring = self.ring.lock().map_err(|e| e.to_string())?;
            let (buf, write_index) = &*ring;

            if buf.is_empty() {
                return Err("No audio recorded yet".to_string());
            }

            let cap = self.capacity;
            let mut temp_ordered: Vec<f32> = Vec::with_capacity(available_len);
            let start = (*write_index + cap - available_len) % cap;

            if start + available_len <= cap {
                temp_ordered.extend_from_slice(&buf[start..start + available_len]);
            } else {
                let first_part = cap - start;
                temp_ordered.extend_from_slice(&buf[start..cap]);
                temp_ordered.extend_from_slice(&buf[..available_len - first_part]);
            }
            temp_ordered
        };

        if ordered.is_empty() {
            return Err("No audio recorded yet".to_string());
        }

        // --- 2. Encode as Opus inside OGG ---
        let mut encoder = opus::Encoder::new(
            OUTPUT_SAMPLE_RATE,
            opus::Channels::Mono,
            opus::Application::Voip,
        )
        .map_err(|e| format!("Opus encoder init: {}", e))?;

        let frame_size: usize = (OUTPUT_SAMPLE_RATE as usize) * 20 / 1000; // 320 samples (20 ms)
        let mut cursor = Cursor::new(Vec::<u8>::new());

        {
            let mut pw = ogg::writing::PacketWriter::new(&mut cursor);
            let serial: u32 = 0x504C5545; // "PLUE"

            // -- OpusHead --
            let pre_skip: u16 = 312;
            let mut head = Vec::with_capacity(19);
            head.extend_from_slice(b"OpusHead");
            head.push(1); // version
            head.push(OUTPUT_CHANNELS as u8);
            head.extend_from_slice(&pre_skip.to_le_bytes());
            head.extend_from_slice(&OUTPUT_SAMPLE_RATE.to_le_bytes());
            head.extend_from_slice(&0u16.to_le_bytes()); // output gain
            head.push(0); // channel mapping family
            pw.write_packet(
                head,
                serial,
                ogg::writing::PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(|e| format!("OGG write OpusHead: {}", e))?;

            // -- OpusTags --
            let vendor = b"runningbord";
            let mut tags = Vec::new();
            tags.extend_from_slice(b"OpusTags");
            tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
            tags.extend_from_slice(vendor);
            tags.extend_from_slice(&0u32.to_le_bytes()); // 0 comments
            pw.write_packet(
                tags,
                serial,
                ogg::writing::PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(|e| format!("OGG write OpusTags: {}", e))?;

            // -- Audio packets --
            // Granule position is always at 48 kHz for Opus
            let granule_increment: u64 = 960; // 20 ms at 48 kHz
            let mut granule_pos: u64 = 0;
            let total_frames = ordered.len() / frame_size;
            let mut encode_buf = vec![0u8; 4000]; // max Opus packet

            for i in 0..total_frames {
                let frame = &ordered[i * frame_size..(i + 1) * frame_size];
                let n = encoder
                    .encode_float(frame, &mut encode_buf)
                    .map_err(|e| format!("Opus encode: {}", e))?;
                granule_pos += granule_increment;

                let end_info = if i == total_frames - 1 {
                    ogg::writing::PacketWriteEndInfo::EndStream
                } else {
                    ogg::writing::PacketWriteEndInfo::NormalPacket
                };
                pw.write_packet(
                    encode_buf[..n].to_vec(),
                    serial,
                    end_info,
                    granule_pos,
                )
                .map_err(|e| format!("OGG write audio: {}", e))?;
            }

            // Handle remaining samples (pad with silence to fill a frame)
            let remainder = ordered.len() % frame_size;
            if remainder > 0 {
                let mut last_frame = vec![0.0f32; frame_size];
                let offset = total_frames * frame_size;
                last_frame[..remainder].copy_from_slice(&ordered[offset..offset + remainder]);
                let n = encoder
                    .encode_float(&last_frame, &mut encode_buf)
                    .map_err(|e| format!("Opus encode tail: {}", e))?;
                granule_pos += granule_increment;
                pw.write_packet(
                    encode_buf[..n].to_vec(),
                    serial,
                    ogg::writing::PacketWriteEndInfo::EndStream,
                    granule_pos,
                )
                .map_err(|e| format!("OGG write tail: {}", e))?;
            }
        }

        let bytes = cursor.into_inner();
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    }
}

/// Lightweight converter that downmixes native interleaved audio to mono and
/// resamples to 16 kHz using linear interpolation with phase continuity.
pub struct AudioConverter {
    src_sample_rate: u32,
    src_channels: u16,
    prev_mono_sample: Option<f32>,
    resample_pos: f64,
}

impl AudioConverter {
    pub fn new(src_sample_rate: u32, src_channels: u16) -> Self {
        Self {
            src_sample_rate,
            src_channels,
            prev_mono_sample: None,
            resample_pos: 0.0,
        }
    }

    pub fn reconfigure(&mut self, src_sample_rate: u32, src_channels: u16) {
        self.src_sample_rate = src_sample_rate;
        self.src_channels = src_channels;
        self.prev_mono_sample = None;
        self.resample_pos = 0.0;
    }

    pub fn update_source_channels_preserve_phase(&mut self, src_channels: u16) {
        self.src_channels = src_channels;
    }

    pub fn source_sample_rate(&self) -> u32 {
        self.src_sample_rate
    }

    pub fn source_channels(&self) -> u16 {
        self.src_channels
    }

    pub fn convert_interleaved(&mut self, input: &[f32]) -> Vec<f32> {
        if self.src_sample_rate == 0 || self.src_channels == 0 {
            return Vec::new();
        }
        let src_channels = self.src_channels as usize;

        let frames = input.len() / src_channels;
        if frames == 0 {
            return Vec::new();
        }

        let mut mono = Vec::with_capacity(frames + 1);
        if let Some(prev) = self.prev_mono_sample {
            mono.push(prev);
        }

        for frame in input.chunks_exact(src_channels) {
            let sum: f32 = frame.iter().copied().sum();
            mono.push(sum / src_channels as f32);
        }

        let last = match mono.last().copied() {
            Some(v) => v,
            None => return Vec::new(),
        };

        // Need at least two points for interpolation.
        if mono.len() < 2 {
            self.prev_mono_sample = Some(last);
            return Vec::new();
        }

        let step = self.src_sample_rate as f64 / OUTPUT_SAMPLE_RATE as f64;
        let mut out = Vec::new();

        while self.resample_pos + 1.0 < mono.len() as f64 {
            let idx = self.resample_pos.floor() as usize;
            let frac = (self.resample_pos - idx as f64) as f32;

            let s0 = mono[idx];
            let s1 = mono[idx + 1];
            out.push(s0 + (s1 - s0) * frac);

            self.resample_pos += step;
        }

        self.resample_pos -= (mono.len() - 1) as f64;
        self.prev_mono_sample = Some(last);

        out
    }
}

#[derive(Clone, Serialize)]
pub struct SystemAudioStatus {
    pub recording: bool,
    pub buffer_seconds: u32,
    pub supported: bool,
}

/// Start the system audio daemon. On non-macOS or if tap fails, returns error.
#[tauri::command]
pub async fn system_audio_start(
    buffer_seconds: u32,
    state: tauri::State<'_, Arc<SystemAudioState>>,
) -> Result<(), String> {
    if state.recording.load(Ordering::SeqCst) {
        return Ok(());
    }
    state.set_buffer_seconds(buffer_seconds);
    state.reset_capture_state();
    // Set recording true before spawning capture so the thread sees it
    state.recording.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = crate::system_audio_macos::start_capture(state.inner().clone()).await {
            state.recording.store(false, Ordering::SeqCst);
            return Err(e);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = crate::system_audio_linux::start_capture(state.inner().clone()).await {
            state.recording.store(false, Ordering::SeqCst);
            return Err(e);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = crate::system_audio_windows::start_capture(state.inner().clone()).await {
            state.recording.store(false, Ordering::SeqCst);
            return Err(e);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = buffer_seconds;
        state.recording.store(false, Ordering::SeqCst);
        return Err("System audio capture is not supported on this platform".to_string());
    }
    Ok(())
}

/// Stop the system audio daemon.
#[tauri::command]
pub async fn system_audio_stop(state: tauri::State<'_, Arc<SystemAudioState>>) -> Result<(), String> {
    state.recording.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        crate::system_audio_macos::stop_capture().await;
    }
    #[cfg(target_os = "linux")]
    {
        crate::system_audio_linux::stop_capture().await;
    }
    #[cfg(target_os = "windows")]
    {
        crate::system_audio_windows::stop_capture().await;
    }
    if let Ok(mut h) = state.capture_handle.lock() {
        if let Some(handle) = h.take() {
            let _ = handle.join();
        }
    }
    Ok(())
}

/// Get the last N seconds of system audio as base64 OGG/Opus (16 kHz mono).
#[tauri::command]
pub async fn system_audio_get_recent_base64(
    state: tauri::State<'_, Arc<SystemAudioState>>,
) -> Result<String, String> {
    state.get_recent_base64()
}

/// Return whether the daemon is currently recording.
#[tauri::command]
pub async fn system_audio_is_recording(
    state: tauri::State<'_, Arc<SystemAudioState>>,
) -> Result<bool, String> {
    Ok(state.is_recording())
}

/// Return status (recording, buffer_seconds, supported).
#[tauri::command]
pub async fn system_audio_status(
    state: tauri::State<'_, Arc<SystemAudioState>>,
) -> Result<SystemAudioStatus, String> {
    let logical_len: usize = *state.logical_len.lock().map_err(|e| e.to_string())?;
    let buffer_seconds = (logical_len as u32) / (OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS as u32);
    Ok(SystemAudioStatus {
        recording: state.is_recording(),
        buffer_seconds,
        supported: cfg!(any(target_os = "macos", target_os = "linux", target_os = "windows")),
    })
}

/// Save base64-encoded OGG/Opus audio to a user-selected path using native Save dialog.
#[tauri::command]
pub async fn system_audio_save_ogg_base64(
    base64_data: String,
    suggested_filename: Option<String>,
) -> Result<Option<String>, String> {
    let file_name = suggested_filename
        .map(|name| {
            if name.trim().is_empty() {
                "system_audio.ogg".to_string()
            } else if name.to_lowercase().ends_with(".ogg") {
                name
            } else {
                format!("{}.ogg", name)
            }
        })
        .unwrap_or_else(|| "system_audio.ogg".to_string());

    let Some(path) = rfd::FileDialog::new()
        .add_filter("OGG audio", &["ogg"])
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(None);
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Invalid base64 audio payload: {}", e))?;

    std::fs::write(&path, bytes).map_err(|e| format!("Failed to save audio file: {}", e))?;

    Ok(Some(path.to_string_lossy().to_string()))
}
