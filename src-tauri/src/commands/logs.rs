use super::devices::{adb_binary, running_avds};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const BATCH_MAX_LINES: usize = 500;
const BATCH_MAX_WAIT: Duration = Duration::from_millis(50);
const MAX_LINE_CHARS: usize = 10_000;
/// Android shows this many recent lines before streaming live ones
const ANDROID_BACKLOG_LINES: &str = "500";

struct Stream {
    generation: u64,
    child: Child,
}

/// Running log-stream child processes, keyed by the label of the window showing them.
#[derive(Default)]
pub struct LogStreams {
    streams: Mutex<HashMap<String, Stream>>,
    next_generation: Mutex<u64>,
}

impl LogStreams {
    fn stop(&self, label: &str) {
        if let Ok(mut streams) = self.streams.lock() {
            if let Some(mut stream) = streams.remove(label) {
                let _ = stream.child.kill();
                let _ = stream.child.wait();
            }
        }
    }

    fn is_current(&self, label: &str, generation: u64) -> bool {
        self.streams
            .lock()
            .map(|streams| streams.get(label).is_some_and(|s| s.generation == generation))
            .unwrap_or(false)
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn window_label(platform: &str, device_id: &str) -> String {
    let id: String = device_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("logs-{}-{}", platform, id)
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

/// Opens a live native-log window for a running device, or focuses it if already open.
#[tauri::command]
pub async fn open_log_window(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
    device_name: String,
) -> Result<(), String> {
    validate(&platform, &device_id)?;
    let label = window_label(&platform, &device_id);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!(
        "index.html?view=logs&platform={}&id={}&name={}",
        percent_encode(&platform),
        percent_encode(&device_id),
        percent_encode(&device_name)
    );

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("Logs - {}", device_name))
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 400.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    // Closing the window must not leave the log process running
    let handle = app.clone();
    let closing_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            handle.state::<LogStreams>().stop(&closing_label);
        }
    });

    Ok(())
}

/// Predicate keeping only log lines from processes whose name contains `text`.
/// `text` is escaped for use inside a predicate string literal.
fn ios_process_predicate(text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    format!("process CONTAINS[c] \"{}\"", escaped)
}

fn spawn_log_process(platform: &str, device_id: &str, app_filter: &str) -> Result<Child, String> {
    let mut command = if platform == "ios" {
        if !cfg!(target_os = "macos") {
            return Err("iOS simulators are only available on macOS".to_string());
        }
        let mut c = Command::new("xcrun");
        c.args(["simctl", "spawn", device_id, "log", "stream", "--style", "compact", "--level", "debug"]);
        // The simulator logs every process on it; narrowing at the source keeps the app's
        // lines from being pushed out of the window's buffer by system noise
        if !app_filter.is_empty() {
            c.args(["--predicate", &ios_process_predicate(app_filter)]);
        }
        c
    } else {
        let serial = running_avds()
            .into_iter()
            .find(|(_, name)| name == device_id)
            .map(|(serial, _)| serial)
            .ok_or_else(|| "Emulator is not running".to_string())?;
        let mut c = Command::new(adb_binary());
        c.args(["-s", &serial, "logcat", "-v", "threadtime", "-T", ANDROID_BACKLOG_LINES]);
        c
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start log stream: {}", e))
}

/// Starts (or restarts) streaming this device's native logs to the calling window as
/// `device-log` events (batches of lines). On iOS, `app_filter` limits the stream to processes whose name contains it. `device-log-end` fires if the stream stops by itself.
#[tauri::command]
pub async fn start_log_stream(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    platform: String,
    device_id: String,
    app_filter: Option<String>,
) -> Result<(), String> {
    validate(&platform, &device_id)?;
    let app_filter = app_filter.unwrap_or_default().trim().to_string();
    let label = window.label().to_string();

    tokio::task::spawn_blocking(move || {
        let state = app.state::<LogStreams>();
        state.stop(&label);

        let mut child = spawn_log_process(&platform, &device_id, &app_filter)?;
        let stdout = child.stdout.take().ok_or("Failed to read the log stream")?;

        let generation = {
            let mut next = state.next_generation.lock().map_err(|e| e.to_string())?;
            *next += 1;
            *next
        };
        state
            .streams
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.clone(), Stream { generation, child });

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            // Raw bytes, so one invalid UTF-8 line can't end the stream
            for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
                let mut text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                if text.chars().count() > MAX_LINE_CHARS {
                    text = text.chars().take(MAX_LINE_CHARS).collect();
                }
                // `log stream` prints a banner before the first entry
                if text.starts_with("Filtering the log data using") || text.starts_with("Timestamp ") {
                    continue;
                }
                if tx.send(text).is_err() {
                    break;
                }
            }
        });

        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = vec![first];
                let deadline = Instant::now() + BATCH_MAX_WAIT;
                while batch.len() < BATCH_MAX_LINES {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(remaining) {
                        Ok(line) => batch.push(line),
                        Err(_) => break,
                    }
                }
                if app.emit_to(&label, "device-log", batch).is_err() {
                    break;
                }
            }

            // Only report if nobody stopped or replaced this stream
            let state = app.state::<LogStreams>();
            if state.is_current(&label, generation) {
                state.stop(&label);
                let _ = app.emit_to(&label, "device-log-end", ());
            }
        });

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Writes the given log text to a new file in the system temp directory and returns its path,
/// so it can be handed to an AI tool that reads files.
#[tauri::command]
pub async fn save_log_snapshot(device_name: String, content: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let name: String = device_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);

        let dir = std::env::temp_dir().join("grovr-logs");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp folder: {}", e))?;
        let path = dir.join(format!("{}-{}.log", name, millis));
        std::fs::write(&path, content).map_err(|e| format!("Failed to write log file: {}", e))?;

        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Maps process IDs to process names (the app's package for app processes) on a running
/// Android emulator. Best effort: an empty map means "unknown".
#[tauri::command]
pub async fn list_android_processes(device_id: String) -> Result<HashMap<String, String>, String> {
    validate("android", &device_id)?;

    tokio::task::spawn_blocking(move || {
        let serial = running_avds()
            .into_iter()
            .find(|(_, name)| name == &device_id)
            .map(|(serial, _)| serial)
            .ok_or_else(|| "Emulator is not running".to_string())?;

        let output = Command::new(adb_binary())
            .args(["-s", &serial, "shell", "ps", "-A", "-o", "PID,NAME"])
            .output()
            .map_err(|e| format!("Failed to run adb: {}", e))?;

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .skip(1)
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let pid = parts.next()?.parse::<u32>().ok()?;
                let name = parts.next()?;
                Some((pid.to_string(), name.to_string()))
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Names of the apps the user installed on a running device (system apps excluded):
/// Android package names, or iOS executable names (what appears as the log's process).
/// Best effort: any failure just yields an empty list.
#[tauri::command]
pub async fn list_user_apps(platform: String, device_id: String) -> Result<Vec<String>, String> {
    validate(&platform, &device_id)?;

    tokio::task::spawn_blocking(move || {
        let mut apps = if platform == "ios" {
            ios_user_apps(&device_id)
        } else {
            android_user_apps(&device_id)
        };
        apps.sort();
        apps.dedup();
        Ok(apps)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn android_user_apps(avd_name: &str) -> Vec<String> {
    let Some(serial) = running_avds()
        .into_iter()
        .find(|(_, name)| name == avd_name)
        .map(|(serial, _)| serial)
    else {
        return Vec::new();
    };

    // -3: third-party (non-system) packages only
    let Ok(output) = Command::new(adb_binary())
        .args(["-s", &serial, "shell", "pm", "list", "packages", "-3"])
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

fn ios_user_apps(udid: &str) -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }

    // `simctl listapps` prints an old-style plist; plutil converts it to JSON
    let Ok(listed) = Command::new("xcrun").args(["simctl", "listapps", udid]).output() else {
        return Vec::new();
    };
    let Ok(mut plutil) = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };

    if let Some(mut stdin) = plutil.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(&listed.stdout);
    }
    let Ok(converted) = plutil.wait_with_output() else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&converted.stdout) else {
        return Vec::new();
    };

    json.as_object()
        .map(|apps| {
            apps.values()
                .filter(|app| app["ApplicationType"] == "User")
                .filter_map(|app| app["CFBundleExecutable"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
