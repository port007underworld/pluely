//! Microphone capture through Apple's voice processing (the echo cancellation
//! FaceTime uses). Without headphones the mic hears the meeting from the
//! speakers, often louder than the user; voice processing removes what the Mac
//! is playing, so only the user's own voice is transcribed.

use crate::mic_audio::MicAudioState;
use crate::system_audio::AudioConverter;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::sel;
use objc2_avf_audio::{
    AVAudioEngine, AVAudioPCMBuffer, AVAudioTime,
    AVAudioVoiceProcessingOtherAudioDuckingConfiguration,
    AVAudioVoiceProcessingOtherAudioDuckingLevel,
};
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

pub struct VoiceProcessingMic {
    engine: Retained<AVAudioEngine>,
    _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
}

impl VoiceProcessingMic {
    /// Opens the default input with voice processing on. Must stay on the
    /// thread that opened it.
    pub fn open(state: Arc<MicAudioState>) -> Result<Self, String> {
        unsafe {
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            input
                .setVoiceProcessingEnabled_error(true)
                .map_err(|e| format!("Couldn't turn on echo cancellation: {}", e))?;
            // By default voice processing turns other apps down, the meeting
            // included. Keep that to the minimum (macOS 14+).
            if input.respondsToSelector(sel!(setVoiceProcessingOtherAudioDuckingConfiguration:)) {
                input.setVoiceProcessingOtherAudioDuckingConfiguration(
                    AVAudioVoiceProcessingOtherAudioDuckingConfiguration {
                        enableAdvancedDucking: false.into(),
                        duckingLevel: AVAudioVoiceProcessingOtherAudioDuckingLevel::Min,
                    },
                );
            }

            // The format reported for a voice-processed input can claim
            // several identical channels; the processed voice is channel 0, at
            // the rate each buffer says.
            let converter = Mutex::new(AudioConverter::new(48_000, 1));
            let tap = RcBlock::new(
                move |pcm: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {
                    let pcm = pcm.as_ref();
                    let frames = pcm.frameLength() as usize;
                    let channels = pcm.floatChannelData();
                    if frames == 0 || channels.is_null() {
                        return;
                    }
                    let rate = pcm.format().sampleRate() as u32;
                    let stride = pcm.stride().max(1);
                    let first = (*channels).as_ptr();
                    let mono: Vec<f32> = (0..frames).map(|i| *first.add(i * stride)).collect();
                    let Ok(mut converter) = converter.lock() else { return };
                    if converter.source_sample_rate() != rate {
                        converter.reconfigure(rate, 1);
                    }
                    let converted = converter.convert_interleaved(&mono);
                    if !converted.is_empty() {
                        state.buffer.push_samples_realtime(&converted);
                    }
                },
            );
            input.installTapOnBus_bufferSize_format_block(0, 4096, None, RcBlock::as_ptr(&tap));
            engine.prepare();
            if let Err(e) = engine.startAndReturnError() {
                input.removeTapOnBus(0);
                return Err(format!("Couldn't start the microphone: {}", e));
            }
            Ok(Self { engine, _tap: tap })
        }
    }

    /// The engine stops by itself when the audio devices change (headphones
    /// plugged in, a Bluetooth headset connecting); the caller reopens it.
    pub fn is_running(&self) -> bool {
        unsafe { self.engine.isRunning() }
    }
}

impl Drop for VoiceProcessingMic {
    fn drop(&mut self) {
        unsafe {
            self.engine.inputNode().removeTapOnBus(0);
            self.engine.stop();
        }
    }
}
