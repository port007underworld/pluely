//! Microphone capture into its own ring buffer, so the user's voice can be
//! transcribed separately from system audio and labelled "You".

use crate::system_audio::{AudioConverter, SystemAudioState};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct MicAudioState {
    pub buffer: SystemAudioState,
}

impl MicAudioState {
    pub fn new() -> Self {
        Self {
            buffer: SystemAudioState::new(),
        }
    }
}

struct Running {
    stop: mpsc::Sender<()>,
    thread: thread::JoinHandle<()>,
    device_name: String,
}

// cpal::Stream is not Send on every backend, so it lives on a dedicated thread
// that holds it until told to stop.
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    state: Arc<MicAudioState>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let mut converter = AudioConverter::new(config.sample_rate.0, config.channels);
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                scratch.clear();
                scratch.extend(data.iter().map(|s| s.to_sample::<f32>()));
                let converted = converter.convert_interleaved(&scratch);
                if !converted.is_empty() {
                    state.buffer.push_samples_realtime(&converted);
                }
            },
            |err| tracing::error!("Microphone stream error: {}", err),
            None,
        )
        .map_err(|e| format!("Failed to open microphone: {}", e))
}

fn open_default_mic(state: Arc<MicAudioState>) -> Result<(cpal::Stream, String), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| "No microphone found".to_string())?;
    let name = device.name().unwrap_or_else(|_| "Microphone".to_string());
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Microphone unavailable (permission denied?): {}", e))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let stream = match format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, state)?,
        SampleFormat::I16 => build_stream::<i16>(&device, &config, state)?,
        SampleFormat::U16 => build_stream::<u16>(&device, &config, state)?,
        SampleFormat::I32 => build_stream::<i32>(&device, &config, state)?,
        other => return Err(format!("Unsupported microphone sample format: {:?}", other)),
    };
    stream
        .play()
        .map_err(|e| format!("Failed to start microphone: {}", e))?;
    Ok((stream, name))
}

/// A running mic delivers audio every ~100 ms, silence included.
#[cfg(target_os = "macos")]
const MIC_STALL: Duration = Duration::from_secs(1);

/// Runs on the mic thread until told to stop. Reports the device name, or why
/// it couldn't be opened, through `ready`.
fn run_mic(
    state: Arc<MicAudioState>,
    ready: mpsc::Sender<Result<String, String>>,
    stop: mpsc::Receiver<()>,
) {
    #[cfg(target_os = "macos")]
    {
        use crate::mic_voice_processing::VoiceProcessingMic;
        match VoiceProcessingMic::open(state.clone()) {
            Ok(mic) => {
                let _ = ready.send(Ok(default_mic_name()));
                let mut mic = Some(mic);
                // Wait for stop, rebuilding the mic if it stopped (the audio
                // devices changed) or stopped delivering audio. Restarting the
                // same engine after a device change runs but stays silent, so
                // it's always built afresh.
                while let Err(mpsc::RecvTimeoutError::Timeout) =
                    stop.recv_timeout(Duration::from_millis(250))
                {
                    let problem = match &mic {
                        None => "isn't open",
                        Some(m) if !m.is_running() => "stopped",
                        Some(m) if m.silent_for() > MIC_STALL => "delivered no audio",
                        Some(_) => continue,
                    };
                    mic = None;
                    match VoiceProcessingMic::open(state.clone()) {
                        Ok(m) => {
                            tracing::info!("Microphone {}; reopened on {}", problem, default_mic_name());
                            mic = Some(m);
                        }
                        Err(e) => tracing::warn!("Microphone {}; reopening failed: {}", problem, e),
                    }
                }
                return;
            }
            Err(e) => tracing::warn!("{}; using the microphone without echo cancellation", e),
        }
    }

    match open_default_mic(state) {
        Ok((stream, name)) => {
            let _ = ready.send(Ok(name));
            let _ = stop.recv();
            drop(stream);
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
}

#[cfg(target_os = "macos")]
fn default_mic_name() -> String {
    cpal::default_host()
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_else(|| "Microphone".to_string())
}

#[tauri::command]
pub async fn mic_audio_start(
    buffer_seconds: u32,
    state: tauri::State<'_, Arc<MicAudioState>>,
) -> Result<String, String> {
    state.buffer.set_buffer_seconds(buffer_seconds);
    let mut running = RUNNING.lock().map_err(|e| e.to_string())?;
    if let Some(r) = running.as_ref() {
        return Ok(r.device_name.clone());
    }

    state.buffer.reset_capture_state();
    state.buffer.set_recording(true);

    let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let mic_state = state.inner().clone();
    let handle = thread::spawn(move || run_mic(mic_state, ready_tx, stop_rx));

    // Permission is checked (and asked for) before this is called, so an open
    // that takes this long means the device is busy or stuck (e.g. a
    // Bluetooth headset switching modes).
    match ready_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(device_name)) => {
            *running = Some(Running {
                stop: stop_tx,
                thread: handle,
                device_name: device_name.clone(),
            });
            Ok(device_name)
        }
        Ok(Err(e)) => {
            state.buffer.set_recording(false);
            Err(e)
        }
        Err(_) => {
            state.buffer.set_recording(false);
            let _ = stop_tx.send(());
            Err("Couldn't open the microphone: it didn't respond within 15 seconds. It may be in use by another app, or a Bluetooth headset may be switching modes; try turning Meeting mode off and on.".to_string())
        }
    }
}

#[tauri::command]
pub async fn mic_audio_stop(state: tauri::State<'_, Arc<MicAudioState>>) -> Result<(), String> {
    state.buffer.set_recording(false);
    let running = RUNNING.lock().map_err(|e| e.to_string())?.take();
    if let Some(r) = running {
        let _ = r.stop.send(());
        let _ = r.thread.join();
    }
    Ok(())
}

#[tauri::command]
pub async fn mic_audio_is_recording(
    state: tauri::State<'_, Arc<MicAudioState>>,
) -> Result<bool, String> {
    Ok(state.buffer.is_recording())
}

#[tauri::command]
pub async fn mic_audio_get_recent_wav_base64(
    seconds: Option<u32>,
    state: tauri::State<'_, Arc<MicAudioState>>,
) -> Result<String, String> {
    state.buffer.get_recent_wav_base64(seconds)
}

#[tauri::command]
pub async fn mic_audio_silence_ratio(
    seconds: Option<u32>,
    state: tauri::State<'_, Arc<MicAudioState>>,
) -> Result<f32, String> {
    Ok(crate::system_audio::silence_ratio(
        &state.buffer.recent_samples(seconds)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records the default mic through the real capture path and writes what
    /// would be transcribed. Run with something playing from the speakers:
    /// MIC_TEST_OUT=/tmp/mic.wav cargo test mic_capture -- --ignored
    #[test]
    #[ignore]
    fn mic_capture() {
        let _ = tracing_subscriber::fmt().with_writer(std::io::stderr).try_init();
        let out = std::env::var("MIC_TEST_OUT").expect("MIC_TEST_OUT");
        let secs: u64 = std::env::var("MIC_TEST_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
        let state = Arc::new(MicAudioState::new());
        state.buffer.set_buffer_seconds(secs as u32 + 5);
        state.buffer.reset_capture_state();
        state.buffer.set_recording(true);
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let s = state.clone();
        let handle = thread::spawn(move || run_mic(s, ready_tx, stop_rx));
        println!("opened: {:?}", ready_rx.recv().unwrap());
        thread::sleep(Duration::from_secs(secs));
        stop_tx.send(()).unwrap();
        handle.join().unwrap();
        let samples = state.buffer.recent_samples(Some(secs as u32 + 5)).unwrap();
        std::fs::write(&out, crate::system_audio::encode_wav_pcm16(&samples)).unwrap();
        println!("wrote {:.1}s", samples.len() as f32 / 16_000.0);
    }
}
