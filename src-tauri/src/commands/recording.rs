//! Screen recording of a running simulator/emulator, for the quick bar's record button.
//!
//! Videos go to a temp folder (cleaned by the OS, and by us after 24 hours); the caller gets
//! the file path to hand to whoever needs the video.

use super::devices::{adb_binary, running_avds};
use super::settings::SettingsState;
use crate::types::QuickBarSettings;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;

const RECORDINGS_DIR: &str = "grovr-recordings";
/// A recording that dies within this long of starting never really started (device not
/// booted, recording unsupported); checked quickly so starting feels instant
const START_CHECK: Duration = Duration::from_millis(350);
const START_POLL: Duration = Duration::from_millis(25);
/// How long finishing a recording (flushing the video file) may take
const STOP_TIMEOUT: Duration = Duration::from_secs(40);
/// Android's `screenrecord` stops by itself after this many seconds (its own maximum)
const ANDROID_TIME_LIMIT_SECS: &str = "180";

/// What `stop_device_recording` hands back
#[derive(Debug, Serialize)]
pub struct FinishedRecording {
    pub path: String,
    /// Size of the video as recorded, and after shrinking (equal when it wasn't shrunk)
    pub original_bytes: u64,
    pub final_bytes: u64,
}

struct ActiveRecording {
    /// `simctl recordVideo` (iOS) or `adb shell screenrecord` (Android)
    child: Child,
    local_path: PathBuf,
    /// Milliseconds since the Unix epoch, for the on-screen timer
    started_at: u64,
    /// Android: the adb serial and the file on the device that is pulled when finished
    android: Option<(String, String)>,
}

#[derive(Default)]
pub struct Recordings(Mutex<HashMap<String, ActiveRecording>>);

fn key(platform: &str, device_id: &str) -> String {
    format!("{}:{}", platform, device_id)
}

fn validate(platform: &str, device_id: &str) -> Result<(), String> {
    if platform != "ios" && platform != "android" {
        return Err("Unknown platform".to_string());
    }
    if device_id.is_empty() || device_id.starts_with('-') {
        return Err("Invalid device".to_string());
    }
    Ok(())
}

fn quick_bar_settings(app: &tauri::AppHandle) -> QuickBarSettings {
    app.state::<SettingsState>()
        .0
        .lock()
        .map(|settings| settings.quick_bar.clone())
        .unwrap_or_default()
}

fn recordings_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(RECORDINGS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the recordings folder: {}", e))?;
    Ok(dir)
}

/// Deletes recordings older than `keep_hours` (0 keeps everything). The OS also clears its temp
/// folder, so anything already gone is simply not there to delete.
fn remove_old_recordings(dir: &std::path::Path, keep_hours: u32) {
    if keep_hours == 0 {
        return;
    }
    let max_age = Duration::from_secs(u64::from(keep_hours) * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn android_serial(avd_name: &str) -> Result<String, String> {
    running_avds()
        .into_iter()
        .find(|(_, name)| name == avd_name)
        .map(|(serial, _)| serial)
        .ok_or_else(|| "Emulator is not running".to_string())
}

fn run(command: &mut Command, what: &str) -> Result<(), String> {
    let output = command.output().map_err(|e| format!("Failed to {}: {}", what, e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    Err(if detail.is_empty() { format!("Failed to {}", what) } else { detail.to_string() })
}

/// Waits for the process to exit; kills it and errors if it takes longer than `timeout`.
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The recording took too long to finish".to_string());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// ffmpeg, if installed. A GUI app doesn't inherit the shell PATH, so look in the usual places.
fn find_ffmpeg() -> Option<PathBuf> {
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// Re-encodes a simulator recording to a much smaller file.
/// `simctl` records with a fast hardware encoder at a high, fixed bitrate (about 8 Mbps), which
/// is wasteful for screens that mostly sit still. x264 at CRF 28 looks the same and is far
/// smaller (a 47 s, 45 MB recording became under 1 MB; busy screens shrink less).
/// Returns the new size, or None if ffmpeg is missing or fails (the original is kept).
fn shrink_video(path: &std::path::Path, options: &QuickBarSettings) -> Option<u64> {
    let ffmpeg = find_ffmpeg()?;
    let temp = path.with_extension("shrunk.mp4");

    let mut filters: Vec<String> = Vec::new();
    if options.video_max_width > 0 {
        // Never scale up; -2 keeps the height even, as the encoders require
        filters.push(format!("scale='min({},iw)':-2", options.video_max_width));
    }
    if options.video_fps > 0 {
        filters.push(format!("fps={}", options.video_fps));
    }

    let mut command = Command::new(ffmpeg);
    command.args(["-v", "error", "-y", "-i"]).arg(path);
    if !filters.is_empty() {
        command.args(["-vf", &filters.join(",")]);
    }
    if options.video_codec == "hevc" {
        command.args(["-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error"]);
    } else {
        command.args(["-c:v", "libx264"]);
    }
    let status = command
        .args(["-crf", &options.video_crf.to_string(), "-preset", "veryfast"])
        .args(["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"])
        .arg(&temp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;

    let original = std::fs::metadata(path).ok()?.len();
    let shrunk = std::fs::metadata(&temp).ok().map(|m| m.len()).unwrap_or(0);
    if status.success() && shrunk > 0 && shrunk < original && std::fs::rename(&temp, path).is_ok() {
        return Some(shrunk);
    }
    let _ = std::fs::remove_file(&temp);
    None
}

/// Starts recording the device's screen. Returns when it started (ms since the Unix epoch).
#[tauri::command]
pub async fn start_device_recording(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
) -> Result<u64, String> {
    validate(&platform, &device_id)?;

    tokio::task::spawn_blocking(move || {
        let state = app.state::<Recordings>();
        let id = key(&platform, &device_id);
        if state.0.lock().map_err(|e| e.to_string())?.contains_key(&id) {
            return Err("Already recording".to_string());
        }

        let dir = recordings_dir()?;
        remove_old_recordings(&dir, quick_bar_settings(&app).recording_keep_hours);

        let millis = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let started_at = millis as u64;
        let name: String = device_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let local_path = dir.join(format!("{}-{}.mp4", name, millis));

        let (mut child, android) = if platform == "ios" {
            if !cfg!(target_os = "macos") {
                return Err("iOS simulators are only available on macOS".to_string());
            }
            let child = Command::new("xcrun")
                .args(["simctl", "io", &device_id, "recordVideo", "--codec=h264", "--force"])
                .arg(&local_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start recording: {}", e))?;
            (child, None)
        } else {
            let serial = android_serial(&device_id)?;
            let remote = format!("/sdcard/grovr-{}.mp4", millis);
            let child = Command::new(adb_binary())
                .args(["-s", &serial, "shell", "screenrecord", "--time-limit", ANDROID_TIME_LIMIT_SECS, &remote])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start recording: {}", e))?;
            (child, Some((serial, remote)))
        };

        // If it dies straight away, say so. Polling returns as soon as there is an answer
        // instead of always waiting out the full check.
        let started = Instant::now();
        while started.elapsed() < START_CHECK {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Recording could not start ({})", status));
            }
            std::thread::sleep(START_POLL);
        }

        state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, ActiveRecording { child, local_path, started_at, android });
        Ok(started_at)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// When the recording of this device started (ms since the Unix epoch), or None if it isn't
/// being recorded. The bar may have been closed and reopened since it started.
#[tauri::command]
pub async fn device_recording_started_at(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
) -> Result<Option<u64>, String> {
    validate(&platform, &device_id)?;
    let started_at = app
        .state::<Recordings>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&key(&platform, &device_id))
        .map(|r| r.started_at);
    Ok(started_at)
}

/// Stops the recording, waits for the video to be finished (and shrunk, for the simulator)
/// and returns its file path and sizes.
#[tauri::command]
pub async fn stop_device_recording(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
) -> Result<FinishedRecording, String> {
    validate(&platform, &device_id)?;

    tokio::task::spawn_blocking(move || {
        let mut recording = app
            .state::<Recordings>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&key(&platform, &device_id))
            .ok_or_else(|| "Not recording".to_string())?;

        match &recording.android {
            None => {
                // Ctrl-C (SIGINT) makes simctl finalize the file; killing it would corrupt the video
                let _ = Command::new("kill").args(["-INT", &recording.child.id().to_string()]).output();
                wait_for_exit(&mut recording.child, STOP_TIMEOUT)?;
            }
            Some((serial, remote)) => {
                // screenrecord runs on the device: interrupt it there so it finishes the file.
                // It may already have stopped by itself (its time limit), which is fine.
                let _ = Command::new(adb_binary())
                    .args(["-s", serial, "shell", "kill -2 $(pidof screenrecord)"])
                    .output();
                wait_for_exit(&mut recording.child, STOP_TIMEOUT)?;

                run(
                    Command::new(adb_binary())
                        .args(["-s", serial, "pull", remote])
                        .arg(&recording.local_path),
                    "copy the recording from the emulator",
                )?;
                let _ = Command::new(adb_binary()).args(["-s", serial, "shell", "rm", remote]).output();
            }
        }

        let original_bytes = std::fs::metadata(&recording.local_path).map(|m| m.len()).unwrap_or(0);
        if original_bytes == 0 {
            return Err("The recording is empty".to_string());
        }

        // Only simulator recordings are shrunk: Android's recorder already uses a modest bitrate
        let options = quick_bar_settings(&app);
        let final_bytes = if recording.android.is_none() && options.shrink_recordings {
            shrink_video(&recording.local_path, &options).unwrap_or(original_bytes)
        } else {
            original_bytes
        };

        Ok(FinishedRecording {
            path: recording.local_path.to_string_lossy().to_string(),
            original_bytes,
            final_bytes,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Stops every recording Grovr started: asks `simctl` to finish its file (SIGINT), and the
/// device-side recorder on Android. Called when the app quits.
pub fn stop_all(app: &tauri::AppHandle) {
    let state = app.state::<Recordings>();
    let Ok(mut recordings) = state.0.lock() else {
        return;
    };
    for (_, mut recording) in recordings.drain() {
        match &recording.android {
            None => {
                let _ = Command::new("kill").args(["-INT", &recording.child.id().to_string()]).output();
            }
            Some((serial, _)) => {
                let _ = Command::new(adb_binary())
                    .args(["-s", serial, "shell", "kill -2 $(pidof screenrecord)"])
                    .output();
            }
        }
        let _ = wait_for_exit(&mut recording.child, Duration::from_secs(5));
    }
}

/// Finishes simulator recordings that an earlier run of the app left going. When the app is
/// restarted or killed it loses track of its `simctl` recorders, which then keep writing
/// (about 1 MB every second) until the simulator shuts down.
pub fn stop_orphans() {
    let pattern = format!("recordVideo.*/{}/", RECORDINGS_DIR);
    let _ = Command::new("pkill").args(["-INT", "-f", &pattern]).output();
}

// ============ Saved recordings (for the settings window) ============

#[derive(Debug, Serialize)]
pub struct RecordingFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Last modified, ms since the Unix epoch
    pub modified_ms: u64,
    /// Still being recorded: can't be deleted yet
    pub in_progress: bool,
}

fn in_progress_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let state = app.state::<Recordings>();
    let Ok(recordings) = state.0.lock() else {
        return Vec::new();
    };
    recordings.values().map(|r| r.local_path.clone()).collect()
}

/// A recording file inside the recordings folder. Anything else is refused, so these commands
/// can't be pointed at other files.
fn recording_path(path: &str) -> Result<PathBuf, String> {
    let dir = recordings_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let file = PathBuf::from(path).canonicalize().map_err(|_| "That recording no longer exists".to_string())?;
    if file.parent() != Some(dir.as_path()) || !file.is_file() {
        return Err("Not a saved recording".to_string());
    }
    Ok(file)
}

/// All saved recordings, newest first.
#[tauri::command]
pub async fn list_recordings(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = recordings_dir()?;
        let active = in_progress_paths(&app);
        let mut files: Vec<RecordingFile> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|entry| {
                let metadata = entry.metadata().ok().filter(|m| m.is_file())?;
                let path = entry.path();
                let modified_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some(RecordingFile {
                    name: entry.file_name().to_string_lossy().to_string(),
                    in_progress: active.contains(&path),
                    path: path.to_string_lossy().to_string(),
                    size: metadata.len(),
                    modified_ms,
                })
            })
            .collect();
        files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        Ok(files)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn delete_recording(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = recording_path(&path)?;
    if in_progress_paths(&app).contains(&file) {
        return Err("This recording is still in progress".to_string());
    }
    std::fs::remove_file(file).map_err(|e| format!("Failed to delete the recording: {}", e))
}

/// Deletes every saved recording except ones still being recorded. Returns how many.
#[tauri::command]
pub async fn delete_all_recordings(app: tauri::AppHandle) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let dir = recordings_dir()?;
        let active = in_progress_paths(&app);
        let mut deleted = 0;
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.is_file() && !active.contains(&path) && std::fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Opens a recording in the default video player.
#[tauri::command]
pub async fn open_recording(path: String) -> Result<(), String> {
    let file = recording_path(&path)?;
    run(Command::new("open").arg(file), "open the recording")
}

/// Shows a recording in Finder.
#[tauri::command]
pub async fn reveal_recording(path: String) -> Result<(), String> {
    let file = recording_path(&path)?;
    run(Command::new("open").arg("-R").arg(file), "show the recording in Finder")
}

/// Where ffmpeg was found, or None. Shrinking recordings needs it.
#[tauri::command]
pub async fn ffmpeg_location() -> Option<String> {
    find_ffmpeg().map(|path| path.to_string_lossy().to_string())
}
