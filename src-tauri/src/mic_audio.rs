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
    let handle = thread::spawn(move || match open_default_mic(mic_state) {
        Ok((stream, name)) => {
            let _ = ready_tx.send(Ok(name));
            let _ = stop_rx.recv();
            drop(stream);
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    });

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
