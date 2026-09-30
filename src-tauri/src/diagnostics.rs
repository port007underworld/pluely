//! A local log file for troubleshooting. Nothing leaves the machine: the user
//! copies what they need from Settings › Diagnostics.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tracing::Level;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::prelude::*;

const LOG_FILE: &str = "runningbord.log";
/// Rotated to runningbord.log.1 at startup once it's this big.
const MAX_LOG_BYTES: u64 = 1_000_000;

fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|e| e.to_string())
}

/// Send warnings and errors (ours at info) to the log file.
pub fn init_logging(app: &AppHandle) {
    let Ok(dir) = log_dir(app) else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join(format!("{LOG_FILE}.1")));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let filter = Targets::new()
        .with_target("runningbord_lib", Level::INFO)
        .with_target("frontend", Level::INFO)
        .with_default(Level::WARN);
    let layer = tracing_subscriber::fmt::layer()
        .with_writer(Mutex::new(file))
        .with_ansi(false)
        .with_target(true);
    let _ = tracing_subscriber::registry().with(layer.with_filter(filter)).try_init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Runningbord started");
}

/// Log a message from the web side (uncaught errors, console.error/warn).
#[tauri::command]
pub fn log_event(level: String, message: String) {
    let message: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

/// The last `max_bytes` of the log, for the diagnostics report.
#[tauri::command]
pub fn diagnostics_log_tail(app: AppHandle, max_bytes: Option<u64>) -> Result<String, String> {
    let path = log_dir(&app)?.join(LOG_FILE);
    let Ok(mut file) = File::open(&path) else {
        return Ok(String::new());
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let take = max_bytes.unwrap_or(32_000).min(len);
    file.seek(SeekFrom::Start(len - take)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(take as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    // Start at a whole line.
    Ok(match (take < len, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text.into_owned(),
    })
}

/// Path of the log file, for "Open log folder".
#[tauri::command]
pub fn diagnostics_log_path(app: AppHandle) -> Result<String, String> {
    Ok(log_dir(&app)?.join(LOG_FILE).to_string_lossy().into_owned())
}
