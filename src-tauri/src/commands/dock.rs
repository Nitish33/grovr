//! A small always-on-top quick-actions bar that docks beside a running simulator/emulator
//! window and follows it around. macOS only: window positions come from CoreGraphics.

use super::devices::{adb_binary, running_avds};
use std::path::PathBuf;
use std::process::Command;

fn dock_label(platform: &str, device_id: &str) -> String {
    let id: String = device_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("dock-{}-{}", platform, id)
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

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

// ============ Following the device window (macOS) ============

#[cfg(target_os = "macos")]
mod follow {
    // The objc crate's macros check a cfg that this crate doesn't declare
    #![allow(unexpected_cfgs, deprecated)]

    use super::*;
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListOptionAll,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
        kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const DOCK_WIDTH: f64 = 48.0;
    const DOCK_HEIGHT: f64 = 232.0;
    const GAP: f64 = 6.0;
    const POLL: Duration = Duration::from_millis(40);
    const PROCESS_SCAN_EVERY: Duration = Duration::from_secs(2);
    /// How long the device window may be gone before the bar closes itself
    const GONE_GRACE: Duration = Duration::from_secs(3);
    /// Smaller windows are toolbars, menu-bar strips and the like, not the device screen
    const MIN_DEVICE_WINDOW: f64 = 150.0;

    #[derive(Debug, Clone)]
    struct WinInfo {
        number: i64,
        pid: i32,
        owner: String,
        name: String,
        layer: i64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    fn number(dict: &CFDictionary<CFString, CFType>, key: core_foundation::string::CFStringRef) -> Option<f64> {
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        dict.find(&key)?.downcast::<CFNumber>()?.to_f64()
    }

    fn text(dict: &CFDictionary<CFString, CFType>, key: core_foundation::string::CFStringRef) -> String {
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        dict.find(&key)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    /// Windows front to back. Positions are in points, origin at the top-left of the main
    /// display, which is what Tauri's logical positions use too.
    fn list_windows(on_screen_only: bool) -> Vec<WinInfo> {
        let option = if on_screen_only { kCGWindowListOptionOnScreenOnly } else { kCGWindowListOptionAll };
        let raw = unsafe { CGWindowListCopyWindowInfo(option, kCGNullWindowID) };
        if raw.is_null() {
            return Vec::new();
        }
        let array: CFArray<CFDictionary<CFString, CFType>> = unsafe { CFArray::wrap_under_create_rule(raw) };

        array
            .iter()
            .filter_map(|dict| {
                let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) };
                let bounds = dict.find(&bounds_key)?.downcast::<CFDictionary>()?;
                let rect_value = |name: &'static str| -> Option<f64> {
                    let key = CFString::from_static_string(name);
                    let value = bounds.find(key.as_concrete_TypeRef() as *const _)?;
                    unsafe { CFNumber::wrap_under_get_rule(*value as core_foundation::number::CFNumberRef) }.to_f64()
                };
                Some(WinInfo {
                    number: unsafe { number(&dict, kCGWindowNumber)? } as i64,
                    pid: unsafe { number(&dict, kCGWindowOwnerPID)? } as i32,
                    owner: unsafe { text(&dict, kCGWindowOwnerName) },
                    name: unsafe { text(&dict, kCGWindowName) },
                    layer: unsafe { number(&dict, kCGWindowLayer) }.unwrap_or(0.0) as i64,
                    x: rect_value("X")?,
                    y: rect_value("Y")?,
                    w: rect_value("Width")?,
                    h: rect_value("Height")?,
                })
            })
            .collect()
    }

    fn is_device_sized(w: &WinInfo) -> bool {
        w.layer == 0 && w.w >= MIN_DEVICE_WINDOW && w.h >= MIN_DEVICE_WINDOW
    }

    /// PIDs of the emulator processes running this AVD. The AVD name must match exactly:
    /// `Pixel_6a` is not `Pixel_6a_API_34`.
    fn emulator_pids(avd_name: &str) -> Vec<i32> {
        let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains("qemu"))
            .filter_map(|line| {
                let mut tokens = line.split_whitespace();
                let pid: i32 = tokens.next()?.parse().ok()?;
                let args: Vec<&str> = tokens.collect();
                let name = args.iter().position(|a| *a == "-avd").and_then(|i| args.get(i + 1))?;
                (*name == avd_name).then_some(pid)
            })
            .collect()
    }

    /// Whether a window title belongs to this device. Titles look like "iPhone 17 Pro",
    /// "iPhone 17 Pro – iOS 26.3" or "Android Emulator - Pixel_6a:5554".
    fn title_matches(title: &str, platform: &str, device_name: &str) -> bool {
        if platform == "ios" {
            title == device_name
                || title.strip_prefix(device_name).is_some_and(|rest| rest.starts_with(" –") || rest.starts_with(" -"))
        } else {
            title.contains(&format!("- {}:", device_name))
        }
    }

    /// The window showing the device, plus the right edge of whatever is attached to it
    /// (the emulator has its own narrow toolbar beside the screen).
    fn find_device_window(
        windows: &[WinInfo],
        platform: &str,
        device_name: &str,
        avd_pids: &[i32],
    ) -> Option<(WinInfo, f64)> {
        let belongs = |w: &WinInfo| {
            if platform == "ios" {
                w.owner == "Simulator"
            } else {
                avd_pids.contains(&w.pid)
            }
        };
        let candidates: Vec<&WinInfo> = windows.iter().filter(|w| belongs(w) && is_device_sized(w)).collect();

        // Titles are only visible with the Screen Recording permission; without it, fall back
        // to the largest window
        let device = candidates
            .iter()
            .find(|w| title_matches(&w.name, platform, device_name))
            .or_else(|| candidates.iter().max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h))))
            .map(|w| (*w).clone())?;

        let right = device.x + device.w;
        let attached_right = windows
            .iter()
            .filter(|w| w.pid == device.pid && w.layer == 0 && w.number != device.number)
            .filter(|w| w.w < MIN_DEVICE_WINDOW && w.h > 100.0 && (w.x - right).abs() < 24.0)
            .map(|w| w.x + w.w)
            .fold(right, f64::max);

        Some((device, attached_right))
    }

    pub fn open(
        app: tauri::AppHandle,
        platform: String,
        device_id: String,
        device_name: String,
    ) -> Result<(), String> {
        let label = dock_label(&platform, &device_id);

        // Already open: the same button closes it
        if let Some(window) = app.get_webview_window(&label) {
            window.close().map_err(|e| e.to_string())?;
            return Ok(());
        }

        let url = format!(
            "index.html?view=dock&platform={}&id={}&name={}",
            percent_encode(&platform),
            percent_encode(&device_id),
            percent_encode(&device_name)
        );
        let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title(format!("Quick actions - {}", device_name))
            .inner_size(DOCK_WIDTH, DOCK_HEIGHT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_on_close = stop.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                stop_on_close.store(true, Ordering::Relaxed);
            }
        });

        // What identifies the device in its window/process: the simulator's title is its
        // display name, while the emulator's title and command line use the AVD id
        let match_name = if platform == "android" { device_id } else { device_name };
        let own_number = ns_window_number(&window);
        std::thread::spawn(move || {
            run_follow_loop(window, stop, platform, match_name, own_number);
        });

        Ok(())
    }

    /// Set GROVR_DOCK_DEBUG=1 to print what the bar is doing (for `pnpm tauri dev`).
    fn debug(message: &str) {
        if std::env::var_os("GROVR_DOCK_DEBUG").is_some() {
            eprintln!("[dock] {}", message);
        }
    }

    /// Puts the bar beside the device window. Done with native coordinates (not Tauri's
    /// position mapping) so it stays correct with several displays of different sizes/scales:
    /// CoreGraphics uses a top-left origin on the main display, AppKit a bottom-left one.
    fn place(window: &tauri::WebviewWindow, device: &WinInfo, right: f64) {
        let (dx, dy, dw, dh) = (device.x, device.y, device.w, device.h);
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            use cocoa::foundation::{NSPoint, NSRect};
            use objc::{class, msg_send, runtime::Object, sel, sel_impl};

            unsafe {
                let screens: *mut Object = msg_send![class!(NSScreen), screens];
                let count: usize = msg_send![screens, count];
                if count == 0 {
                    return;
                }
                let primary: *mut Object = msg_send![screens, objectAtIndex: 0usize];
                let primary_frame: NSRect = msg_send![primary, frame];
                let primary_height = primary_frame.size.height;

                // The display the device is on, as a range of x in CoreGraphics coordinates
                let (center_x, center_y) = (dx + dw / 2.0, dy + dh / 2.0);
                let mut screen_left = primary_frame.origin.x;
                let mut screen_right = primary_frame.origin.x + primary_frame.size.width;
                for i in 0..count {
                    let screen: *mut Object = msg_send![screens, objectAtIndex: i];
                    let frame: NSRect = msg_send![screen, frame];
                    let top = primary_height - (frame.origin.y + frame.size.height);
                    if center_x >= frame.origin.x
                        && center_x < frame.origin.x + frame.size.width
                        && center_y >= top
                        && center_y < top + frame.size.height
                    {
                        screen_left = frame.origin.x;
                        screen_right = frame.origin.x + frame.size.width;
                        break;
                    }
                }

                // Beside the device; on its left if there is no room on the right
                let mut x = right + GAP;
                if x + DOCK_WIDTH > screen_right {
                    x = (dx - DOCK_WIDTH - GAP).max(screen_left);
                }
                let y = dy + 8.0;

                if let Ok(ptr) = target.ns_window() {
                    let ns_window = ptr as *mut Object;
                    if !ns_window.is_null() {
                        let _: () = msg_send![ns_window, setFrameTopLeftPoint: NSPoint::new(x, primary_height - y)];
                    }
                }
            }
        });
    }

    fn ns_window_number(window: &tauri::WebviewWindow) -> Option<i64> {
        use objc::{msg_send, runtime::Object, sel, sel_impl};
        let ptr = window.ns_window().ok()? as *mut Object;
        if ptr.is_null() {
            return None;
        }
        let number: i64 = unsafe { msg_send![ptr, windowNumber] };
        Some(number)
    }

    fn run_follow_loop(
        window: tauri::WebviewWindow,
        stop: Arc<AtomicBool>,
        platform: String,
        device_name: String,
        own_number: Option<i64>,
    ) {
        let own_pid = std::process::id() as i32;
        let mut avd_pids: Vec<i32> = Vec::new();
        let mut last_scan: Option<Instant> = None;
        let mut gone_since: Option<Instant> = None;
        let mut shown = false;
        let mut last_pos: Option<(f64, f64, f64)> = None;

        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(POLL);

            if platform == "android" && last_scan.map_or(true, |t| t.elapsed() >= PROCESS_SCAN_EVERY) {
                avd_pids = emulator_pids(&device_name);
                last_scan = Some(Instant::now());
            }

            let on_screen = list_windows(true);
            let found = find_device_window(&on_screen, &platform, &device_name, &avd_pids);

            let Some((device, right)) = found else {
                // Minimised or on another desktop: hide, but only close once it's really gone
                if shown {
                    let _ = window.hide();
                    shown = false;
                    debug("device window not on screen: bar hidden");
                }
                let still_exists =
                    find_device_window(&list_windows(false), &platform, &device_name, &avd_pids).is_some();
                if still_exists {
                    gone_since = None;
                } else {
                    let since = *gone_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= GONE_GRACE {
                        debug("device window is gone: closing the bar");
                        let _ = window.close();
                        return;
                    }
                }
                continue;
            };
            gone_since = None;

            // Only float above the device while the device (or this app) is the front-most;
            // otherwise the bar would sit on top of unrelated apps
            let front = on_screen
                .iter()
                .find(|w| is_device_sized(w) && Some(w.number) != own_number);
            let visible = front.is_some_and(|w| w.pid == device.pid || w.pid == own_pid);

            if last_pos != Some((device.x, device.y, right)) {
                place(&window, &device, right);
                last_pos = Some((device.x, device.y, right));
                debug(&format!(
                    "device window #{} '{}' at ({}, {}) {}x{}, bar anchored at right edge {}",
                    device.number, device.name, device.x, device.y, device.w, device.h, right
                ));
            }
            if visible != shown {
                let _ = if visible { window.show() } else { window.hide() };
                shown = visible;
                debug(&format!("bar {}", if visible { "shown" } else { "hidden (another app is in front)" }));
            }
        }
    }
}

#[tauri::command]
pub async fn toggle_device_dock(
    app: tauri::AppHandle,
    platform: String,
    device_id: String,
    device_name: String,
) -> Result<(), String> {
    validate(&platform, &device_id)?;

    #[cfg(target_os = "macos")]
    {
        follow::open(app, platform, device_id, device_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, device_name);
        Err("The quick actions bar is only available on macOS".to_string())
    }
}

// ============ Quick actions ============

fn android_serial(avd_name: &str) -> Result<String, String> {
    running_avds()
        .into_iter()
        .find(|(_, name)| name == avd_name)
        .map(|(serial, _)| serial)
        .ok_or_else(|| "Emulator is not running".to_string())
}

fn run(command: &mut Command, what: &str) -> Result<Vec<u8>, String> {
    let output = command.output().map_err(|e| format!("Failed to {}: {}", what, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() { format!("Failed to {}", what) } else { detail.to_string() });
    }
    Ok(output.stdout)
}

fn simctl(args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    run(Command::new("xcrun").arg("simctl").args(args), what)
}

fn adb(serial: &str, args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    run(Command::new(adb_binary()).args(["-s", serial]).args(args), what)
}

fn screenshot_path(device_id: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("Could not find the home folder")?;
    let name: String = device_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(home.join("Desktop").join(format!("{}-{}.png", name, millis)))
}

/// Only plain URLs / deep links: a scheme, no whitespace or control characters.
fn valid_link(url: &str) -> bool {
    let scheme_end = url.find(':');
    !url.is_empty()
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && scheme_end.is_some_and(|i| {
            i > 0
                && url[..i].chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && url[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
}

/// Runs one quick action on a running device. Returns a short result for the UI:
/// the saved file path for `screenshot`, the new mode for `toggle_appearance`.
#[tauri::command]
pub async fn device_quick_action(
    platform: String,
    device_id: String,
    action: String,
    payload: Option<String>,
) -> Result<Option<String>, String> {
    validate(&platform, &device_id)?;

    tokio::task::spawn_blocking(move || {
        let ios = platform == "ios";
        match action.as_str() {
            "screenshot" => {
                let path = screenshot_path(&device_id)?;
                let path_str = path.to_string_lossy().to_string();
                if ios {
                    simctl(&["io", &device_id, "screenshot", &path_str], "take a screenshot")?;
                } else {
                    let serial = android_serial(&device_id)?;
                    let png = adb(&serial, &["exec-out", "screencap", "-p"], "take a screenshot")?;
                    std::fs::write(&path, png).map_err(|e| format!("Failed to save the screenshot: {}", e))?;
                }
                Ok(Some(path_str))
            }
            "toggle_appearance" => {
                if ios {
                    let current = simctl(&["ui", &device_id, "appearance"], "read the appearance")?;
                    let next = if String::from_utf8_lossy(&current).trim() == "dark" { "light" } else { "dark" };
                    simctl(&["ui", &device_id, "appearance", next], "change the appearance")?;
                    Ok(Some(next.to_string()))
                } else {
                    let serial = android_serial(&device_id)?;
                    let current = adb(&serial, &["shell", "cmd", "uimode", "night"], "read the appearance")?;
                    let is_night = String::from_utf8_lossy(&current).to_lowercase().contains("yes");
                    let next = if is_night { "no" } else { "yes" };
                    adb(&serial, &["shell", "cmd", "uimode", "night", next], "change the appearance")?;
                    Ok(Some(if is_night { "light" } else { "dark" }.to_string()))
                }
            }
            "open_url" => {
                let url = payload.unwrap_or_default().trim().to_string();
                if !valid_link(&url) {
                    return Err("The clipboard doesn't contain a link".to_string());
                }
                if ios {
                    simctl(&["openurl", &device_id, &url], "open the link")?;
                } else {
                    let serial = android_serial(&device_id)?;
                    // `adb shell` joins its arguments into one shell command line on the device,
                    // so quote the URL
                    let quoted = format!("'{}'", url.replace('\'', "'\\''"));
                    let command = format!("am start -a android.intent.action.VIEW -d {}", quoted);
                    adb(&serial, &["shell", &command], "open the link")?;
                }
                Ok(None)
            }
            "shutdown" => {
                if ios {
                    simctl(&["shutdown", &device_id], "shut down the simulator")?;
                } else {
                    let serial = android_serial(&device_id)?;
                    adb(&serial, &["emu", "kill"], "shut down the emulator")?;
                }
                Ok(None)
            }
            _ => Err("Unknown action".to_string()),
        }
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
