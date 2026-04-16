//! macOS system audio capture using Core Audio Process Tap API (macOS 14.2+).
//! Falls back to a silence placeholder thread if the tap API is unavailable.

use crate::system_audio::{AudioConverter, SystemAudioState};
use std::ffi::{c_char, c_void, CStr};
use std::ptr;
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use std::time::Duration;

// ObjC types for CATapDescription
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::AnyThread;
use objc2_core_audio::{CATapDescription, CATapMuteBehavior};
use objc2_foundation::{NSArray, NSNumber};

// ---------------------------------------------------------------------------
// Raw FFI types
// ---------------------------------------------------------------------------

type AudioObjectID = u32;
type OSStatus = i32;

#[repr(C)]
struct AudioObjectPropertyAddress {
    m_selector: u32,
    m_scope: u32,
    m_element: u32,
}

/// IO proc callback function pointer type (matches Apple's AudioDeviceIOProc)
type AudioIOProc = unsafe extern "C" fn(
    device: AudioObjectID,
    now: *const c_void,              // *const AudioTimeStamp
    input_data: *const c_void,       // *const AudioBufferList
    input_time: *const c_void,       // *const AudioTimeStamp
    output_data: *mut c_void,        // *mut AudioBufferList
    output_time: *const c_void,      // *const AudioTimeStamp
    client_data: *mut c_void,
) -> OSStatus;

type AudioIOProcID = Option<AudioIOProc>;

// Raw AudioBuffer / AudioBufferList for reading in the IO proc callback
#[repr(C)]
struct RawAudioBuffer {
    _number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct RawAudioBufferList {
    number_buffers: u32,
    buffers: [RawAudioBuffer; 1], // C flexible array member
}

// ---------------------------------------------------------------------------
// CoreAudio C functions (linked through the CoreAudio framework,
// which objc2-core-audio already links)
// ---------------------------------------------------------------------------

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioHardwareCreateProcessTap(
        description: *const c_void,
        out_tap_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(tap_id: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: *const c_void,
        out_device_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(device_id: AudioObjectID) -> OSStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectID,
        proc_fn: AudioIOProc,
        client_data: *mut c_void,
        out_proc_id: *mut AudioIOProcID,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(
        device: AudioObjectID,
        proc_id: AudioIOProcID,
    ) -> OSStatus;
    fn AudioDeviceStart(
        device: AudioObjectID,
        proc_id: AudioIOProcID,
    ) -> OSStatus;
    fn AudioDeviceStop(
        device: AudioObjectID,
        proc_id: AudioIOProcID,
    ) -> OSStatus;
    fn AudioObjectGetPropertyData(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OSStatus;
}

const K_AUDIO_DEVICE_PROPERTY_NOMINAL_SAMPLE_RATE: u32 = 0x6e73_7274; // 'nsrt'
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = 0x676c_6f62; // 'glob'
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

// ---------------------------------------------------------------------------
// CoreFoundation C functions for building the aggregate device dictionary
// ---------------------------------------------------------------------------

const CFSTR_ENCODING_UTF8: u32 = 0x08000100;
const CF_NUMBER_SINT32_TYPE: i64 = 3;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const c_void;

    fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const c_char,
        encoding: u32,
    ) -> *const c_void;

    fn CFNumberCreate(
        alloc: *const c_void,
        number_type: i64,
        value_ptr: *const c_void,
    ) -> *const c_void;

    fn CFArrayCreate(
        alloc: *const c_void,
        values: *const *const c_void,
        count: isize,
        callbacks: *const c_void,
    ) -> *const c_void;

    fn CFDictionaryCreate(
        alloc: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;

    fn CFRelease(cf: *const c_void);
}

// Opaque callback structs – we only ever pass their address to CF functions.
// Using addr_of! avoids creating a typed reference to a foreign-sized static.
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFTypeDictionaryValueCallBacks: u8;
    static kCFTypeArrayCallBacks: u8;
}

// ---------------------------------------------------------------------------
// State for the active tap (singleton – only one tap at a time)
// ---------------------------------------------------------------------------

struct TapState {
    tap_id: AudioObjectID,
    aggregate_device_id: AudioObjectID,
    io_proc_id: AudioIOProcID,
    /// Prevent the Arc from being dropped while the IO proc holds a raw ptr.
    _context_arc: Arc<CallbackContext>,
}

unsafe impl Send for TapState {}

static TAP_STATE: StdMutex<Option<TapState>> = StdMutex::new(None);

struct CallbackContext {
    state: Arc<SystemAudioState>,
    converter: StdMutex<AudioConverter>,
}

// ---------------------------------------------------------------------------
// IO proc callback – called on the CoreAudio real-time thread
// ---------------------------------------------------------------------------

unsafe extern "C" fn audio_io_proc_callback(
    device: AudioObjectID,
    _now: *const c_void,
    input_data: *const c_void,
    _input_time: *const c_void,
    _output_data: *mut c_void,
    _output_time: *const c_void,
    client_data: *mut c_void,
) -> OSStatus {
    if client_data.is_null() || input_data.is_null() {
        return 0;
    }

    let context = &*(client_data as *const CallbackContext);
    if !context.state.is_recording() {
        return 0;
    }

    let buf_list = &*(input_data as *const RawAudioBufferList);
    let n = buf_list.number_buffers as usize;
    if n == 0 {
        return 0;
    }

    // mBuffers is a C flexible array member; read `n` elements.
    let buffers = std::slice::from_raw_parts(buf_list.buffers.as_ptr(), n);

    let mut interleaved: Vec<f32> = Vec::new();
    let mut source_channels: u16 = 0;

    // One buffer with multiple channels (interleaved)
    if n == 1 {
        let buf = &buffers[0];
        if !buf.data.is_null() && buf.data_byte_size > 0 {
            let num_samples = buf.data_byte_size as usize / std::mem::size_of::<f32>();
            let samples = std::slice::from_raw_parts(buf.data as *const f32, num_samples);
            interleaved.extend_from_slice(samples);
            source_channels = buf._number_channels.max(1) as u16;
        }
    } else {
        // Multiple buffers are typically planar channels. Interleave by frame.
        let mut planes: Vec<&[f32]> = Vec::new();
        let mut min_samples = usize::MAX;
        for buf in buffers {
            if buf.data.is_null() || buf.data_byte_size == 0 {
                continue;
            }
            let num_samples = buf.data_byte_size as usize / std::mem::size_of::<f32>();
            let samples = std::slice::from_raw_parts(buf.data as *const f32, num_samples);
            min_samples = min_samples.min(samples.len());
            planes.push(samples);
        }

        if !planes.is_empty() && min_samples != usize::MAX {
            source_channels = planes.len() as u16;
            interleaved.reserve(min_samples * planes.len());
            for i in 0..min_samples {
                for p in &planes {
                    interleaved.push(p[i]);
                }
            }
        }
    }

    if source_channels == 0 || interleaved.is_empty() {
        return 0;
    }

    if let Ok(mut converter) = context.converter.try_lock() {
        // Lazily initialize converter only after capture has started and we
        // have real callback format data.
        if converter.source_sample_rate() == 0 || converter.source_channels() == 0 {
            let actual_rate = query_device_sample_rate(device).unwrap_or(48000);
            converter.reconfigure(actual_rate, source_channels.max(1));
        } else if converter.source_channels() != source_channels {
            // Channel count can flicker at startup; keep resampling phase to
            // avoid audible discontinuities.
            converter.update_source_channels_preserve_phase(source_channels.max(1));
        }
        let converted = converter.convert_interleaved(&interleaved);
        if !converted.is_empty() {
            context.state.push_samples_realtime(&converted);
        }
    }

    0 // noErr
}

unsafe fn query_device_sample_rate(device_id: AudioObjectID) -> Option<u32> {
    let address = AudioObjectPropertyAddress {
        m_selector: K_AUDIO_DEVICE_PROPERTY_NOMINAL_SAMPLE_RATE,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut sample_rate_hz: f64 = 0.0;
    let mut size = std::mem::size_of::<f64>() as u32;
    let status = AudioObjectGetPropertyData(
        device_id,
        &address,
        0,
        ptr::null(),
        &mut size,
        (&mut sample_rate_hz as *mut f64).cast(),
    );
    if status == 0 && sample_rate_hz.is_finite() && sample_rate_hz > 0.0 {
        Some(sample_rate_hz.round() as u32)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Helper: build the CFDictionary for AudioHardwareCreateAggregateDevice
// ---------------------------------------------------------------------------

/// Create a CFString from a null-terminated byte slice. Caller must CFRelease.
unsafe fn cf_str(s: &[u8]) -> *const c_void {
    CFStringCreateWithCString(
        ptr::null(),
        s.as_ptr() as *const c_char,
        CFSTR_ENCODING_UTF8,
    )
}

/// Build the aggregate device description dictionary.
/// The dictionary includes the tap (identified by `tap_uuid_cstr`) and is
/// configured as a private device with auto-start.
/// Returns a CFDictionaryRef that the caller must CFRelease.
unsafe fn build_aggregate_device_dict(tap_uuid_cstr: *const c_char) -> *const c_void {
    let key_cb = core::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks) as *const c_void;
    let val_cb = core::ptr::addr_of!(kCFTypeDictionaryValueCallBacks) as *const c_void;
    let arr_cb = core::ptr::addr_of!(kCFTypeArrayCallBacks) as *const c_void;

    // --- Sub-dict for the tap entry: { "uid": "<tap_uuid>" } ---
    let sub_uid_key = cf_str(b"uid\0");
    let sub_uid_val = CFStringCreateWithCString(ptr::null(), tap_uuid_cstr, CFSTR_ENCODING_UTF8);
    let sub_keys = [sub_uid_key];
    let sub_vals = [sub_uid_val];
    let sub_dict = CFDictionaryCreate(
        ptr::null(),
        sub_keys.as_ptr(),
        sub_vals.as_ptr(),
        1,
        key_cb,
        val_cb,
    );
    CFRelease(sub_uid_key);
    CFRelease(sub_uid_val);

    // --- Tap list array: [ sub_dict ] ---
    let arr_vals: [*const c_void; 1] = [sub_dict];
    let tap_array = CFArrayCreate(ptr::null(), arr_vals.as_ptr(), 1, arr_cb);
    CFRelease(sub_dict);

    // --- Main dict ---
    let uid_key = cf_str(b"uid\0");
    let name_key = cf_str(b"name\0");
    let private_key = cf_str(b"private\0");
    let taps_key = cf_str(b"taps\0");
    let autostart_key = cf_str(b"tapautostart\0");

    let uid_val = cf_str(b"com.runningbord.system_audio_tap_agg\0");
    let name_val = cf_str(b"Runningbord System Audio\0");
    let one: i32 = 1;
    let private_val = CFNumberCreate(
        ptr::null(),
        CF_NUMBER_SINT32_TYPE,
        &one as *const i32 as *const c_void,
    );
    // tap_array is already created above
    let autostart_val = kCFBooleanTrue;

    let keys = [uid_key, name_key, private_key, taps_key, autostart_key];
    let vals = [
        uid_val,
        name_val,
        private_val,
        tap_array as *const c_void,
        autostart_val,
    ];

    let dict = CFDictionaryCreate(ptr::null(), keys.as_ptr(), vals.as_ptr(), 5, key_cb, val_cb);

    // Release our refs (the dict retains what it needs)
    CFRelease(uid_key);
    CFRelease(name_key);
    CFRelease(private_key);
    CFRelease(taps_key);
    CFRelease(autostart_key);
    CFRelease(uid_val);
    CFRelease(name_val);
    CFRelease(private_val);
    CFRelease(tap_array);
    // autostart_val (kCFBooleanTrue) is a global constant – don't release

    dict
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start capturing system audio into the given state's ring buffer.
/// On macOS 14.2+: uses Core Audio Process Tap API (no virtual driver needed).
/// On older macOS: falls back to a silence placeholder thread.
pub async fn start_capture(state: Arc<SystemAudioState>) -> Result<(), String> {
    // Try the real Process Tap first
    match try_start_process_tap(state.clone()) {
        Ok(()) => {
            tracing::info!("System audio capture started via Core Audio Process Tap");
            Ok(())
        }
        Err(e) => {
            tracing::warn!("Process Tap failed ({}), using silence placeholder", e);
            start_silence_fallback(state);
            Ok(())
        }
    }
}

/// Attempt to start real system audio capture via the Core Audio Process Tap API.
fn try_start_process_tap(state: Arc<SystemAudioState>) -> Result<(), String> {
    // Runtime check: CATapDescription class must exist (macOS 14.2+)
    let cls_name =
        CStr::from_bytes_with_nul(b"CATapDescription\0").expect("invalid CStr");
    if AnyClass::get(cls_name).is_none() {
        return Err(
            "CATapDescription class not available (requires macOS 14.2+)".to_string(),
        );
    }

    unsafe {
        // 1. Create tap description – stereo global tap of all processes
        let empty_array: Retained<NSArray<NSNumber>> = NSArray::new();
        let tap_desc = CATapDescription::initStereoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &empty_array,
        );

        // Audio should still play through speakers (unmuted)
        tap_desc.setMuteBehavior(CATapMuteBehavior::Unmuted);

        // 2. Create the process tap
        let mut tap_id: AudioObjectID = 0;
        let tap_desc_ptr = &*tap_desc as *const CATapDescription as *const c_void;
        let status = AudioHardwareCreateProcessTap(tap_desc_ptr, &mut tap_id);
        if status != 0 {
            return Err(format!(
                "AudioHardwareCreateProcessTap failed with status {}. \
                 Make sure 'Screen & System Audio Recording' permission is granted in \
                 System Settings > Privacy & Security.",
                status
            ));
        }

        // 3. Get the tap's UUID string for the aggregate device config
        let uuid = tap_desc.UUID();
        let uuid_nsstring = uuid.UUIDString();
        let uuid_cstr = uuid_nsstring.UTF8String();
        if uuid_cstr.is_null() {
            AudioHardwareDestroyProcessTap(tap_id);
            return Err("Failed to get tap UUID string".to_string());
        }

        // 4. Build the aggregate device dictionary and create the device
        let agg_dict = build_aggregate_device_dict(uuid_cstr);
        if agg_dict.is_null() {
            AudioHardwareDestroyProcessTap(tap_id);
            return Err("Failed to create aggregate device dictionary".to_string());
        }

        let mut agg_device_id: AudioObjectID = 0;
        let status = AudioHardwareCreateAggregateDevice(agg_dict, &mut agg_device_id);
        CFRelease(agg_dict);

        if status != 0 {
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!(
                "AudioHardwareCreateAggregateDevice failed with status {}",
                status
            ));
        }

        // 5. Register our IO proc callback on the aggregate device
        let callback_context = Arc::new(CallbackContext {
            state: state.clone(),
            converter: StdMutex::new(AudioConverter::new(0, 0)),
        });
        let state_ptr = Arc::as_ptr(&callback_context) as *mut c_void;
        let mut io_proc_id: AudioIOProcID = None;
        let status = AudioDeviceCreateIOProcID(
            agg_device_id,
            audio_io_proc_callback,
            state_ptr,
            &mut io_proc_id,
        );
        if status != 0 {
            AudioHardwareDestroyAggregateDevice(agg_device_id);
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!(
                "AudioDeviceCreateIOProcID failed with status {}",
                status
            ));
        }

        // 6. Start the device – audio will now flow through the callback
        let status = AudioDeviceStart(agg_device_id, io_proc_id);
        if status != 0 {
            AudioDeviceDestroyIOProcID(agg_device_id, io_proc_id);
            AudioHardwareDestroyAggregateDevice(agg_device_id);
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!(
                "AudioDeviceStart failed with status {}",
                status
            ));
        }

        // 7. Store state for cleanup
        let mut guard = TAP_STATE.lock().map_err(|e| e.to_string())?;
        *guard = Some(TapState {
            tap_id,
            aggregate_device_id: agg_device_id,
            io_proc_id,
            _context_arc: callback_context,
        });
    }

    Ok(())
}

/// Fallback: run a thread that pushes silence into the ring buffer so the
/// attach flow can still be tested (returns valid WAV with silence).
fn start_silence_fallback(state: Arc<SystemAudioState>) {
    let state_clone = state.clone();
    let handle = thread::spawn(move || {
        let chunk = 1600usize; // ~100 ms at 16 kHz mono
        let sleep_duration = Duration::from_millis(100);
        while state_clone.is_recording() {
            let silence = vec![0.0f32; chunk];
            state_clone.push_samples_realtime(&silence);
            thread::sleep(sleep_duration);
        }
    });
    state.store_capture_handle(handle);
}

/// Stop the capture (tear down tap, aggregate device, IO proc).
pub async fn stop_capture() {
    let tap_state = {
        let mut guard = match TAP_STATE.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!("TAP_STATE mutex poisoned: {}", e);
                return;
            }
        };
        guard.take()
    };

    if let Some(ts) = tap_state {
        unsafe {
            AudioDeviceStop(ts.aggregate_device_id, ts.io_proc_id);
            AudioDeviceDestroyIOProcID(ts.aggregate_device_id, ts.io_proc_id);
            AudioHardwareDestroyAggregateDevice(ts.aggregate_device_id);
            AudioHardwareDestroyProcessTap(ts.tap_id);
        }
        tracing::info!("System audio Process Tap stopped");
    }
    // If the silence fallback thread is running, it will exit because
    // state.recording was set to false in system_audio_stop().
}
