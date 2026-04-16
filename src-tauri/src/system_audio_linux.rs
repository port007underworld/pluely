//! Linux system audio capture using PipeWire.
//! Captures the monitor of the default audio sink (system audio output).
//! Requires PipeWire to be running (default on Ubuntu 24+, Fedora 34+, etc.).

use crate::system_audio::{AudioConverter, SystemAudioState};
use std::rc::Rc;
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;

use pipewire as pw;
use pw::spa;

/// Thread-safe handle for controlling the PipeWire capture thread.
struct CaptureHandle {
    quit_tx: pw::channel::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

struct UserData {
    format: spa::param::audio::AudioInfoRaw,
    converter: AudioConverter,
}

static CAPTURE_STATE: StdMutex<Option<CaptureHandle>> = StdMutex::new(None);

/// Start capturing system audio via PipeWire.
/// Creates a PipeWire stream connected to the default audio sink monitor
/// (i.e. what is being played through speakers), capturing 48 kHz stereo F32.
pub async fn start_capture(state: Arc<SystemAudioState>) -> Result<(), String> {
    // Check if already capturing
    {
        let guard = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
    }

    let (quit_tx, quit_rx) = pw::channel::channel::<()>();

    // Use a oneshot channel to propagate init errors back to the caller
    let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread_handle = thread::spawn(move || {
        match run_pipewire_capture(state, quit_rx) {
            Ok(()) => {
                // Successfully initialised – signal success then run the loop
                // (run_pipewire_capture blocks until quit is signalled)
            }
            Err(e) => {
                let _ = init_tx.send(Err(e.clone()));
                tracing::error!("PipeWire capture init error: {}", e);
            }
        }
    });

    // We can't easily wait for init because the PipeWire loop blocks in
    // the thread.  Instead, if the thread panics/exits quickly, we'll
    // notice on stop.  Store the handle optimistically.
    let mut guard = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
    *guard = Some(CaptureHandle {
        quit_tx,
        thread: Some(thread_handle),
    });

    Ok(())
}

/// Run the PipeWire main loop and capture audio.
/// This blocks until the quit signal is received via `quit_rx`.
fn run_pipewire_capture(
    state: Arc<SystemAudioState>,
    quit_rx: pw::channel::Receiver<()>,
) -> Result<(), String> {
    pw::init();

    let main_loop = Rc::new(
        pw::main_loop::MainLoop::new(None)
            .map_err(|e| format!("Failed to create PipeWire MainLoop: {}", e))?,
    );
    let context = pw::context::Context::new(&*main_loop)
        .map_err(|e| format!("Failed to create PipeWire Context: {}", e))?;
    let core = context.connect(None)
        .map_err(|e| format!("Failed to connect PipeWire Core: {}", e))?;

    // Attach quit channel – when stop_capture() sends (), quit the main loop
    let ml_for_quit = Rc::clone(&main_loop);
    let _quit_recv = quit_rx.attach(main_loop.loop_(), move |()| {
        ml_for_quit.quit();
    });

    // -----------------------------------------------------------------------
    // Create the capture stream targeting the default audio sink monitor.
    // "stream.capture.sink" = "true" tells PipeWire to capture what goes to
    // speakers – the monitor port of the default sink.
    // -----------------------------------------------------------------------
    let stream = pw::stream::Stream::new(
        &core,
        "pluely-system-audio",
        pw::properties::properties! {
            "media.type" => "Audio",
            "media.category" => "Capture",
            "media.role" => "Music",
            "stream.capture.sink" => "true",
        },
    )
    .map_err(|e| format!("Failed to create PipeWire Stream: {}", e))?;

    // -----------------------------------------------------------------------
    // Build audio format Pod: F32LE only.
    // Leaving rate/channels unset lets PipeWire negotiate native graph format.
    // -----------------------------------------------------------------------
    let mut audio_info = spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(spa::param::audio::AudioFormat::F32LE);

    let values: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: spa::param::ParamType::EnumFormat.as_raw(),
            properties: audio_info.into(),
        }),
    )
    .map_err(|e| format!("Failed to serialize audio format Pod: {:?}", e))?
    .0
    .into_inner();

    let pod = spa::pod::Pod::from_bytes(&values)
        .ok_or_else(|| "Failed to create Pod from serialized bytes".to_string())?;

    // -----------------------------------------------------------------------
    // Register callbacks: parse negotiated native format, then convert each
    // process buffer into 16 kHz mono before pushing to the shared ring buffer.
    // -----------------------------------------------------------------------
    let user_data = UserData {
        format: spa::param::audio::AudioInfoRaw::new(),
        converter: AudioConverter::new(48000, 2),
    };

    let _listener = stream
        .add_local_listener_with_user_data(user_data)
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else {
                return;
            };
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }

            let Ok((media_type, media_subtype)) = pw::spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != pw::spa::param::format::MediaType::Audio
                || media_subtype != pw::spa::param::format::MediaSubtype::Raw
            {
                return;
            }

            if user_data.format.parse(param).is_ok() {
                let rate = user_data.format.rate().max(1);
                let channels = user_data.format.channels().max(1) as u16;
                user_data.converter.reconfigure(rate, channels);
                tracing::info!(
                    "PipeWire negotiated format: {} Hz, {} ch",
                    rate,
                    channels
                );
            }
        })
        .process(move |stream, user_data| {
            match stream.dequeue_buffer() {
                None => { /* no buffer available this cycle */ }
                Some(mut buffer) => {
                    let datas = buffer.datas_mut();
                    if let Some(d) = datas.first() {
                        let chunk = d.chunk();
                        let offset = chunk.offset() as usize;
                        let size = chunk.size() as usize;
                        if size == 0 {
                            return;
                        }
                        if let Some(data) = d.data() {
                            if offset + size > data.len() {
                                return;
                            }
                            let audio_bytes = &data[offset..offset + size];
                            let n_samples =
                                audio_bytes.len() / std::mem::size_of::<f32>();
                            if n_samples > 0 {
                                let samples: &[f32] = unsafe {
                                    std::slice::from_raw_parts(
                                        audio_bytes.as_ptr() as *const f32,
                                        n_samples,
                                    )
                                };
                                let converted = user_data.converter.convert_interleaved(samples);
                                if !converted.is_empty() {
                                    state.push_samples_realtime(&converted);
                                }
                            }
                        }
                    }
                }
            }
        })
        .register()
        .map_err(|e| format!("Failed to register stream listener: {}", e))?;

    // -----------------------------------------------------------------------
    // Connect the stream.
    // Direction::Input = we are consuming audio (reading from the sink monitor).
    // AUTOCONNECT = PipeWire automatically links us to the default sink.
    // MAP_BUFFERS = map data buffers into our address space for zero-copy reads.
    // -----------------------------------------------------------------------
    stream
        .connect(
            spa::utils::Direction::Input,
            None, // PW_ID_ANY – connect to default
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut [pod],
        )
        .map_err(|e| format!("Failed to connect PipeWire stream: {}", e))?;

    tracing::info!("PipeWire system audio capture started");
    main_loop.run();
    tracing::info!("PipeWire main loop exited, capture stopped");

    Ok(())
}

/// Stop the PipeWire capture thread.
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

    if let Some(mut h) = handle {
        // Signal the PipeWire main loop to quit
        let _ = h.quit_tx.send(());

        // Wait for the capture thread to finish
        if let Some(thread) = h.thread.take() {
            let _ = thread.join();
        }

        tracing::info!("PipeWire system audio capture stopped");
    }
}
