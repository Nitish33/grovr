use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Device {
    /// iOS: simulator UDID. Android: AVD name.
    pub id: String,
    pub name: String,
    /// e.g. "iOS 26.3". None for Android.
    pub runtime: Option<String>,
    /// e.g. "Booted" / "Shutdown". None when unknown (Android).
    pub state: Option<String>,
}

/// "com.apple.CoreSimulator.SimRuntime.iOS-26-3" -> ("iOS", [26, 3])
fn parse_runtime(key: &str) -> (String, Vec<u32>) {
    let tail = key.rsplit('.').next().unwrap_or(key);
    match tail.split_once('-') {
        Some((os, ver)) => (
            os.to_string(),
            ver.split('-').filter_map(|p| p.parse().ok()).collect(),
        ),
        None => (tail.to_string(), Vec::new()),
    }
}

fn format_runtime(os: &str, version: &[u32]) -> String {
    if version.is_empty() {
        return os.to_string();
    }
    let ver: Vec<String> = version.iter().map(|n| n.to_string()).collect();
    format!("{} {}", os, ver.join("."))
}

fn parse_simulators(json: &Value) -> Vec<Device> {
    let Some(runtimes) = json.get("devices").and_then(|d| d.as_object()) else {
        return Vec::new();
    };

    let mut groups: Vec<((String, Vec<u32>), &Vec<Value>)> = runtimes
        .iter()
        .filter_map(|(key, devices)| devices.as_array().map(|d| (parse_runtime(key), d)))
        .collect();

    // iOS first, then other platforms; newest runtime first within a platform
    groups.sort_by(|((os_a, ver_a), _), ((os_b, ver_b), _)| {
        (os_a != "iOS", os_a, std::cmp::Reverse(ver_a))
            .cmp(&(os_b != "iOS", os_b, std::cmp::Reverse(ver_b)))
    });

    let mut result = Vec::new();
    for ((os, version), devices) in groups {
        let runtime = format_runtime(&os, &version);
        for device in devices {
            if device.get("isAvailable").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            let (Some(id), Some(name)) = (
                device.get("udid").and_then(|v| v.as_str()),
                device.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            result.push(Device {
                id: id.to_string(),
                name: name.to_string(),
                runtime: Some(runtime.clone()),
                state: device.get("state").and_then(|v| v.as_str()).map(String::from),
            });
        }
    }
    result
}

#[tauri::command]
pub async fn list_ios_simulators() -> Result<Vec<Device>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }

    tokio::task::spawn_blocking(|| {
        let output = Command::new("xcrun")
            .args(["simctl", "list", "devices", "available", "--json"])
            .output()
            .map_err(|e| format!("Failed to run xcrun (is Xcode installed?): {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let json: Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse simctl output: {}", e))?;
        Ok(parse_simulators(&json))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// GUI apps don't inherit the shell PATH, so look in the usual SDK locations first.
fn find_emulator_binary() -> Option<PathBuf> {
    let bin = if cfg!(target_os = "windows") { "emulator.exe" } else { "emulator" };
    let mut sdk_roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(PathBuf::from))
        .collect();

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        sdk_roots.push(home.join("Library/Android/sdk"));
        sdk_roots.push(home.join("Android/Sdk"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        sdk_roots.push(local.join("Android").join("Sdk"));
    }

    sdk_roots
        .into_iter()
        .map(|root| root.join("emulator").join(bin))
        .find(|path| path.is_file())
}

#[tauri::command]
pub async fn list_android_emulators() -> Result<Vec<Device>, String> {
    tokio::task::spawn_blocking(|| {
        let program = find_emulator_binary().unwrap_or_else(|| PathBuf::from("emulator"));

        let output = Command::new(&program)
            .arg("-list-avds")
            .output()
            .map_err(|e| {
                format!(
                    "Android emulator not found. Install the Android SDK or set ANDROID_HOME ({})",
                    e
                )
            })?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        // Output may include INFO lines before the AVD names; AVD names contain no spaces
        let devices = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.contains(' ') && !line.starts_with("INFO"))
            .map(|name| Device {
                id: name.to_string(),
                name: name.replace('_', " "),
                runtime: None,
                state: None,
            })
            .collect();
        Ok(devices)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn launch_ios_simulator(udid: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS simulators are only available on macOS".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let output = Command::new("xcrun")
            .args(["simctl", "boot", &udid])
            .output()
            .map_err(|e| format!("Failed to run xcrun: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Booting an already-booted device is fine - we still want to show its window
            if !stderr.contains("current state: Booted") {
                return Err(stderr.trim().to_string());
            }
        }

        let output = Command::new("open")
            .args(["-a", "Simulator", "--args", "-CurrentDeviceUDID", &udid])
            .output()
            .map_err(|e| format!("Failed to open Simulator: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn launch_android_emulator(avd_name: String) -> Result<(), String> {
    if avd_name.is_empty() || avd_name.starts_with('-') {
        return Err("Invalid emulator name".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let program = find_emulator_binary().unwrap_or_else(|| PathBuf::from("emulator"));

        let mut child = Command::new(&program)
            .args(["-avd", &avd_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start emulator: {}", e))?;

        // The emulator is long-running. If it dies right away (e.g. already running
        // or a broken AVD), report it instead of silently doing nothing.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(format!("Emulator exited immediately ({})", status));
            }
            Ok(Some(_)) => {}
            _ => {
                // Still running: reap it in the background so it doesn't become a zombie
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
