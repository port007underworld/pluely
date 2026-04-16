//! Windows system audio capture using WASAPI loopback via the `cpal` crate.
//! Captures what is being played through the default output device (speakers/headphones)
//! on Windows 10/11. Building an input stream on an output device triggers WASAPI's
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` mode automatically.

use crate::system_audio::{AudioConverter, SystemAudioState};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex as StdMutex};

/// Holds the active cpal loopback stream. Dropping it stops capture.
struct CaptureHandle {
    _stream: cpal::Stream,
}

// SAFETY: cpal::Stream is Send on the WASAPI backend.
unsafe impl Send for CaptureHandle {}

static CAPTURE_STATE: StdMutex<Option<CaptureHandle>> = StdMutex::new(None);

/// Start capturing system audio via WASAPI loopback.
///
/// Opens the default output device and builds an **input** stream on it, which
/// tells WASAPI to capture the loopback (monitor) audio — i.e. everything that
/// is being played to speakers.
pub async fn start_capture(state: Arc<SystemAudioState>) -> Result<(), String> {
    // Check if already capturing
    {
        let guard = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
    }

    let host = cpal::default_host();

    let device = host
        .default_output_device()
        .ok_or_else(|| "No default output audio device found".to_string())?;

    let supported_config = device
        .default_output_config()
        .map_err(|e| format!("Failed to get default output config: {}", e))?;

    let device_sample_rate = supported_config.sample_rate().0;
    let device_channels = supported_config.channels() as u16;

    tracing::info!(
        "WASAPI loopback: device config {} Hz, {} ch, {:?}",
        device_sample_rate,
        device_channels,
        supported_config.sample_format()
    );

    let stream_config: cpal::StreamConfig = supported_config.into();

    // Build an input stream on the output device → WASAPI loopback mode.
    // The data callback receives interleaved f32 samples.
    let state_clone = state.clone();
    let converter = Arc::new(StdMutex::new(AudioConverter::new(
        device_sample_rate,
        device_channels,
    )));
    let converter_clone = converter.clone();
    let stream = device
        .build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut conv) = converter_clone.try_lock() {
                    let converted = conv.convert_interleaved(data);
                    if !converted.is_empty() {
                        state_clone.push_samples_realtime(&converted);
                    }
                }
            },
            |err| {
                tracing::error!("WASAPI loopback stream error: {}", err);
            },
            None, // no timeout
        )
        .map_err(|e| format!("Failed to build WASAPI loopback stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start WASAPI loopback stream: {}", e))?;

    tracing::info!("WASAPI loopback system audio capture started");

    let mut guard = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
    *guard = Some(CaptureHandle { _stream: stream });

    Ok(())
}

/// Stop the WASAPI loopback capture. Dropping the stream handle releases all
/// WASAPI / COM resources.
pub async fn stop_capture() {
    let handle = {
        let mut guard = match CAPTURE_STATE.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!("CAPTURE_STATE mutex poisoned: {}", e);
                return;
            }
        };
        guard.take()
    };

    if handle.is_some() {
        // The stream is dropped here, which stops playback and releases resources.
        tracing::info!("WASAPI loopback system audio capture stopped");
    }
}
