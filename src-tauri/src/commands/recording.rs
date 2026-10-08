//! Screen recording of a running simulator/emulator, for the quick bar's record button.
//!
//! Videos go to a temp folder (cleaned by the OS, and by us after 24 hours); the caller gets
//! the file path to hand to whoever needs the video.

// The objc crate's macros check a cfg that this crate doesn't declare.
#![allow(unexpected_cfgs, deprecated)]

use super::devices::{adb_binary, running_avds};
use super::dock;
use super::settings::SettingsState;
use crate::types::QuickBarSettings;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

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
    pub log_path: Option<String>,
    pub prompt: String,
    /// Size of the video as recorded, and after shrinking (equal when it wasn't shrunk)
    pub original_bytes: u64,
    pub final_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RecordingToggleResult {
    Started { started_at: u64 },
    Stopped { recording: FinishedRecording },
}

struct ActiveRecording {
    /// `simctl recordVideo` (iOS) or `adb shell screenrecord` (Android)
    child: Child,
    local_path: PathBuf,
    /// Milliseconds since the Unix epoch, for the on-screen timer
    started_at: u64,
    /// Android: the adb serial and the file on the device that is pulled when finished
    android: Option<(String, String)>,
    touch_capture: Option<TouchCapture>,
    log_capture: Option<LogCapture>,
}

#[derive(Debug, Clone, Serialize)]
struct TouchSample {
    time: f64,
    x_ratio: f64,
    y_ratio: f64,
}

struct TouchCapture {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<TouchSample>>>,
    calibration: TouchCalibration,
}

struct LogCapture {
    child: Child,
    process_group: Option<u32>,
    path: PathBuf,
    done: mpsc::Receiver<()>,
    app_filter: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct TouchCalibration {
    aspect: Option<f64>,
    y_bias: f64,
}

#[derive(Debug, Clone, Copy)]
struct ScreenMetrics {
    width: f64,
    height: f64,
}

impl ScreenMetrics {
    fn aspect(self) -> f64 {
        self.width / self.height
    }
}

fn screen_metrics(platform: &str, device_id: &str) -> Option<ScreenMetrics> {
    if platform == "ios" {
        let path = std::env::temp_dir().join(format!("grovr-screen-aspect-{}.png", std::process::id()));
        let status = Command::new("xcrun")
            .args(["simctl", "io", device_id, "screenshot"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        if !status.success() {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let output = Command::new("sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight"])
            .arg(&path)
            .output()
            .ok()?;
        let _ = std::fs::remove_file(&path);
        let text = String::from_utf8_lossy(&output.stdout);
        let mut width = None;
        let mut height = None;
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(value) = trimmed.strip_prefix("pixelWidth:") {
                width = value.trim().parse::<f64>().ok();
            } else if let Some(value) = trimmed.strip_prefix("pixelHeight:") {
                height = value.trim().parse::<f64>().ok();
            }
        }
        return width
            .zip(height)
            .filter(|(w, h)| *w > 0.0 && *h > 0.0)
            .map(|(width, height)| ScreenMetrics { width, height });
    }

    let serial = android_serial(device_id).ok()?;
    let output = Command::new(adb_binary())
        .args(["-s", &serial, "shell", "wm", "size"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let size = text.split_whitespace().find(|part| part.contains('x'))?;
    let (width, height) = size.split_once('x')?;
    let width = width.trim().parse::<f64>().ok()?;
    let height = height.trim().parse::<f64>().ok()?;
    (width > 0.0 && height > 0.0).then_some(ScreenMetrics { width, height })
}

fn content_rect(rect: (f64, f64, f64, f64), calibration: TouchCalibration) -> (f64, f64, f64, f64) {
    let Some(aspect) = calibration.aspect.filter(|value| *value > 0.0) else {
        return rect;
    };
    let (x, y, w, h) = rect;
    let window_aspect = w / h;
    if window_aspect > aspect {
        let content_w = h * aspect;
        (x + (w - content_w) / 2.0, y, content_w, h)
    } else {
        let content_h = w / aspect;
        (x, y + (h - content_h) / 2.0, w, content_h)
    }
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

fn sanitize_name(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

fn logs_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("grovr-recording-logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the recording logs folder: {}", e))?;
    Ok(dir)
}

fn ios_log_terms(bundle_id: &str, js_only: bool) -> Vec<String> {
    if js_only {
        return vec!["com.facebook.react.log".to_string(), "javascript".to_string()];
    }
    let mut terms = vec![bundle_id.to_string()];
    if let Some(last) = bundle_id.rsplit('.').next().filter(|value| !value.is_empty()) {
        terms.push(last.to_string());
    }
    terms.sort();
    terms.dedup();
    terms
}

fn ios_process_predicate(terms: &[String], js_only: bool) -> String {
    if js_only {
        return "subsystem == \"com.facebook.react.log\" AND category == \"javascript\"".to_string();
    }
    let clauses = terms.iter().flat_map(|text| {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        [
            format!("process CONTAINS[c] \"{}\"", escaped),
            format!("subsystem CONTAINS[c] \"{}\"", escaped),
            format!("category CONTAINS[c] \"{}\"", escaped),
            format!("eventMessage CONTAINS[c] \"{}\"", escaped),
        ]
    });
    clauses.collect::<Vec<_>>().join(" OR ")
}

fn write_log_capture_header(file: &mut std::fs::File, platform: &str, device_id: &str, app_filter: &str) {
    let _ = writeln!(file, "# Grovr recording log capture");
    let _ = writeln!(file, "# Platform: {}", platform);
    let _ = writeln!(file, "# Device: {}", device_id);
    let _ = writeln!(file, "# App filter: {}", app_filter);
    let _ = writeln!(file, "# Started: {:?}", SystemTime::now());
    let _ = writeln!(file);
}

fn append_empty_log_note(path: &std::path::Path) {
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = writeln!(file);
        let _ = writeln!(
            file,
            "# No app log lines were emitted while recording. The app may not have logged, the process name may differ from the bundle/package, or the app was not running when recording started."
        );
    }
}

fn android_log_pid_args(serial: &str, package: &str) -> Vec<String> {
    Command::new(adb_binary())
        .args(["-s", serial, "shell", "pidof", package])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
        .map(|pids| pids.split_whitespace().flat_map(|pid| ["--pid".to_string(), pid.to_string()]).collect())
        .unwrap_or_default()
}

fn start_log_capture(platform: &str, device_id: &str, millis: u128, js_only: bool) -> Option<LogCapture> {
    let app_filter = if platform == "ios" {
        dock::current_ios_bundle_id(device_id).ok()
    } else {
        android_serial(device_id)
            .ok()
            .and_then(|serial| dock::current_android_package(&serial).ok())
    }?;

    let path = logs_dir()
        .ok()?
        .join(format!("{}-{}-{}.log", sanitize_name(device_id), sanitize_name(&app_filter), millis));

    let mut command = if platform == "ios" {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let mut c = Command::new("xcrun");
        c.args(["simctl", "spawn", device_id, "log", "stream", "--style", "compact", "--level", "debug"]);
        c.args(["--predicate", &ios_process_predicate(&ios_log_terms(&app_filter, js_only), js_only)]);
        c
    } else {
        let serial = android_serial(device_id).ok()?;
        let mut c = Command::new(adb_binary());
        c.args(["-s", &serial, "logcat", "-v", "threadtime", "-T", "1"]);
        if js_only {
            c.args(["-s", "ReactNativeJS:V", "*:S"]);
        } else {
            for arg in android_log_pid_args(&serial, &app_filter) {
                c.arg(arg);
            }
        }
        c
    };

    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader_path = path.clone();
    let reader_platform = platform.to_string();
    let reader_device_id = device_id.to_string();
    let reader_app_filter = app_filter.clone();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok(mut file) = std::fs::File::create(&reader_path) else {
            let _ = done_tx.send(());
            return;
        };
        write_log_capture_header(&mut file, &reader_platform, &reader_device_id, &reader_app_filter);
        for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            if text.starts_with("Filtering the log data using") || text.starts_with("Timestamp ") {
                continue;
            }
            let _ = writeln!(file, "{}", text);
        }
        let _ = done_tx.send(());
    });

    let process_group = Some(child.id());
    Some(LogCapture { child, process_group, path, done: done_rx, app_filter })
}

fn stop_log_capture(capture: &mut LogCapture) -> Option<PathBuf> {
    #[cfg(unix)]
    if let Some(group) = capture.process_group {
        let _ = Command::new("kill").args(["-TERM", &format!("-{}", group)]).output();
    }
    let _ = capture.child.kill();
    let _ = capture.child.wait();
    let _ = capture.done.recv_timeout(Duration::from_millis(250));
    if std::fs::read_to_string(&capture.path)
        .map(|text| !text.lines().any(|line| !line.trim().is_empty() && !line.starts_with('#')))
        .unwrap_or(false)
    {
        append_empty_log_note(&capture.path);
    }
    std::fs::metadata(&capture.path)
        .ok()
        .filter(|m| m.len() > 0)
        .map(|_| capture.path.clone())
}

fn recording_prompt(video_path: &std::path::Path, log_path: Option<&std::path::Path>, app_filter: Option<&str>) -> String {
    let video = video_path.to_string_lossy();
    match log_path {
        Some(log) => format!(
            "Please analyze this mobile app issue using both attached artifacts:\n\nVideo recording: {}\nApp logs{}: {}\n\nUse the video to understand the visible behavior and the logs to identify errors, warnings, failed requests, crashes, or suspicious timing around the same moment. Summarize the likely root cause and suggest concrete next debugging or fix steps.",
            video,
            app_filter.map(|filter| format!(" filtered by {}", filter)).unwrap_or_default(),
            log.to_string_lossy(),
        ),
        None => format!(
            "Please analyze this mobile app issue using the attached video recording:\n\nVideo recording: {}\n\nNo app log file was captured for this recording. Use the video to summarize the visible behavior and suggest concrete next debugging or fix steps.",
            video,
        ),
    }
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

#[cfg(target_os = "macos")]
fn mouse_location() -> Option<(f64, f64)> {
    use cocoa::foundation::{NSPoint, NSRect};
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};

    unsafe {
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return None;
        }
        let primary: *mut Object = msg_send![screens, objectAtIndex: 0usize];
        let primary_frame: NSRect = msg_send![primary, frame];
        let point: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        Some((point.x, primary_frame.size.height - point.y))
    }
}

#[cfg(not(target_os = "macos"))]
fn mouse_location() -> Option<(f64, f64)> {
    None
}

#[cfg(target_os = "macos")]
fn primary_mouse_pressed() -> bool {
    use objc::{class, msg_send, sel, sel_impl};
    let buttons: u64 = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    buttons & 1 == 1
}

#[cfg(not(target_os = "macos"))]
fn primary_mouse_pressed() -> bool {
    false
}

fn start_touch_capture(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
    started_at: Instant,
    calibration: TouchCalibration,
) -> Option<TouchCapture> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let initial_rect = content_rect(dock::device_rect(&app, &platform, &device_id)?, calibration);
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::new()));
    let stop_thread = stop.clone();
    let samples_thread = samples.clone();

    std::thread::spawn(move || {
        let mut last_sample_at = Duration::ZERO;
        while !stop_thread.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(16));
            if !primary_mouse_pressed() {
                continue;
            }
            let Some((mx, my)) = mouse_location() else {
                continue;
            };
            let (rx, ry, rw, rh) = dock::device_rect(&app, &platform, &device_id)
                .map(|rect| content_rect(rect, calibration))
                .unwrap_or(initial_rect);
            if rw <= 0.0 || rh <= 0.0 || mx < rx || mx > rx + rw || my < ry || my > ry + rh {
                continue;
            }
            let elapsed = started_at.elapsed();
            if elapsed.saturating_sub(last_sample_at) < Duration::from_millis(32) {
                continue;
            }
            last_sample_at = elapsed;
            if let Ok(mut list) = samples_thread.lock() {
                list.push(TouchSample {
                    time: elapsed.as_secs_f64(),
                    x_ratio: ((mx - rx) / rw).clamp(0.0, 1.0),
                    y_ratio: (((my - ry) / rh) + calibration.y_bias).clamp(0.0, 1.0),
                });
            }
        }
    });

    Some(TouchCapture { stop, samples, calibration })
}

fn ffmpeg_color(color: &str) -> &'static str {
    match color {
        "blue" => "0x60A5FA",
        "yellow" => "0xFACC15",
        "pink" => "0xF472B6",
        "white" => "white",
        _ => "0x4ADE80",
    }
}

fn marker_lavfi(color: &str) -> String {
    format!(
        "color=c={}@0.75:s=96x96,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),190,0)'",
        ffmpeg_color(color)
    )
}

fn overlay_touch_filters(samples: &[TouchSample], base_label: &str) -> (String, String) {
    let mut filters = Vec::new();
    let mut input = base_label.to_string();
    for (index, sample) in samples.iter().enumerate() {
        let output = format!("touch{}", index);
        let start = (sample.time - 0.05).max(0.0);
        let end = sample.time + 0.22;
        filters.push(format!(
            "[{}][1:v]overlay=shortest=1:x='{:.6}*main_w-overlay_w/2':y='{:.6}*main_h-overlay_h/2':enable='between(t,{:.3},{:.3})'[{}]",
            input, sample.x_ratio, sample.y_ratio, start, end, output
        ));
        input = output;
    }
    (filters.join(";"), input)
}

#[derive(Serialize)]
struct TouchDebug<'a> {
    calibration: TouchCalibration,
    samples: &'a [TouchSample],
}

fn write_touch_debug(path: &std::path::Path, calibration: TouchCalibration, samples: &[TouchSample]) {
    if std::env::var_os("GROVR_TOUCH_DEBUG").is_none() {
        return;
    }
    let debug_path = path.with_extension("touches.json");
    if let Ok(json) = serde_json::to_string_pretty(&TouchDebug { calibration, samples }) {
        let _ = std::fs::write(debug_path, json);
    }
}

/// Re-encodes a simulator recording to a much smaller file.
/// `simctl` records with a fast hardware encoder at a high, fixed bitrate (about 8 Mbps), which
/// is wasteful for screens that mostly sit still. x264 at CRF 28 looks the same and is far
/// smaller (a 47 s, 45 MB recording became under 1 MB; busy screens shrink less).
/// Returns the new size, or None if ffmpeg is missing or fails (the original is kept).
fn process_video(
    path: &std::path::Path,
    options: &QuickBarSettings,
    touches: &[TouchSample],
    apply_shrink_filters: bool,
) -> Option<u64> {
    let ffmpeg = find_ffmpeg()?;
    let temp = path.with_extension("grovr-processing.tmp.mp4");
    let _ = std::fs::remove_file(&temp);

    let mut base_filters: Vec<String> = Vec::new();
    if apply_shrink_filters && options.video_max_width > 0 {
        // Never scale up; -2 keeps the height even, as the encoders require
        base_filters.push(format!("scale='min({},iw)':-2", options.video_max_width));
    }
    if apply_shrink_filters && options.video_fps > 0 {
        base_filters.push(format!("fps={}", options.video_fps));
    }

    let mut command = Command::new(ffmpeg);
    command.args(["-v", "error", "-y", "-i"]).arg(path);
    if options.recording_show_touches && !touches.is_empty() {
        command.args(["-f", "lavfi", "-i", &marker_lavfi(&options.recording_touch_color)]);
        let (base_label, mut filter_complex) = if base_filters.is_empty() {
            ("0:v".to_string(), String::new())
        } else {
            ("base".to_string(), format!("[0:v]{}[base]", base_filters.join(",")))
        };
        let (touch_chain, output_label) = overlay_touch_filters(touches, &base_label);
        if !filter_complex.is_empty() {
            filter_complex.push(';');
        }
        filter_complex.push_str(&touch_chain);
        command.args(["-filter_complex", &filter_complex, "-map", &format!("[{}]", output_label)]);
    } else if !base_filters.is_empty() {
        command.args(["-vf", &base_filters.join(",")]);
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
    let processed = std::fs::metadata(&temp).ok().map(|m| m.len()).unwrap_or(0);
    let should_replace = options.recording_show_touches && !touches.is_empty() || processed < original;
    if status.success() && processed > 0 && should_replace && std::fs::rename(&temp, path).is_ok() {
        return Some(processed);
    }
    let _ = std::fs::remove_file(&temp);
    None
}

fn finish_recording(
    mut recording: ActiveRecording,
    app: &tauri::AppHandle,
) -> Result<FinishedRecording, String> {
    let (log_path, app_filter) = if let Some(mut capture) = recording.log_capture.take() {
        let app_filter = capture.app_filter.clone();
        (stop_log_capture(&mut capture), Some(app_filter))
    } else {
        (None, None)
    };

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

    let options = quick_bar_settings(app);
    let (touch_samples, touch_calibration) = if let Some(capture) = recording.touch_capture.take() {
        capture.stop.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(40));
        (
            capture.samples.lock().map(|samples| samples.clone()).unwrap_or_default(),
            Some(capture.calibration),
        )
    } else {
        (Vec::new(), None)
    };
    if let Some(calibration) = touch_calibration {
        write_touch_debug(&recording.local_path, calibration, &touch_samples);
    }

    // Android's recorder already uses a modest bitrate, so shrinking is still simulator-only.
    // Touches are burned in for both platforms when samples were captured.
    let apply_shrink_filters = recording.android.is_none() && options.shrink_recordings;
    let should_process = apply_shrink_filters
        || (options.recording_show_touches && !touch_samples.is_empty());
    let final_bytes = if should_process {
        process_video(&recording.local_path, &options, &touch_samples, apply_shrink_filters).unwrap_or(original_bytes)
    } else {
        original_bytes
    };

    Ok(FinishedRecording {
        prompt: recording_prompt(&recording.local_path, log_path.as_deref(), app_filter.as_deref()),
        path: recording.local_path.to_string_lossy().to_string(),
        log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        original_bytes,
        final_bytes,
    })
}

/// Starts recording the device's screen. Returns when it started (ms since the Unix epoch).
#[tauri::command]
pub async fn start_device_recording(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
) -> Result<RecordingToggleResult, String> {
    validate(&platform, &device_id)?;

    tokio::task::spawn_blocking(move || {
        let state = app.state::<Recordings>();
        let id = key(&platform, &device_id);
        if let Some(recording) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) {
            return finish_recording(recording, &app).map(|recording| RecordingToggleResult::Stopped { recording });
        }

        let dir = recordings_dir()?;
        let options = quick_bar_settings(&app);
        remove_old_recordings(&dir, options.recording_keep_hours);

        let millis = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let started_at = millis as u64;
        let name = sanitize_name(&device_id);
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
        let process_started = Instant::now();
        while process_started.elapsed() < START_CHECK {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Recording could not start ({})", status));
            }
            std::thread::sleep(START_POLL);
        }

        let metrics = (options.recording_show_touches && find_ffmpeg().is_some())
            .then(|| screen_metrics(&platform, &device_id))
            .flatten();
        let calibration = TouchCalibration {
            aspect: metrics.map(ScreenMetrics::aspect),
            // Simulator window coordinates sit slightly below the MP4 coordinate space.
            // Move only simulator markers up by 20 recorded pixels; emulator mapping is fine.
            y_bias: if platform == "ios" {
                metrics.map(|m| -20.0 / m.height).unwrap_or(0.0)
            } else {
                0.0
            },
        };
        let touch_capture = (options.recording_show_touches && find_ffmpeg().is_some())
            .then(|| start_touch_capture(app.clone(), platform.clone(), device_id.clone(), process_started, calibration))
            .flatten();
        let log_capture = options
            .recording_capture_logs
            .then(|| start_log_capture(&platform, &device_id, millis, options.recording_capture_js_logs_only))
            .flatten();

        state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, ActiveRecording { child, local_path, started_at, android, touch_capture, log_capture });
        Ok(RecordingToggleResult::Started { started_at })
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
        let recording = app
            .state::<Recordings>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&key(&platform, &device_id))
            .ok_or_else(|| "Not recording".to_string())?;
        finish_recording(recording, &app)
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
        if let Some(capture) = recording.touch_capture.take() {
            capture.stop.store(true, Ordering::Relaxed);
        }
        if let Some(mut capture) = recording.log_capture.take() {
            let _ = stop_log_capture(&mut capture);
        }
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
