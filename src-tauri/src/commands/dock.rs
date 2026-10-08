//! A small always-on-top quick-actions bar that docks beside a running simulator/emulator
//! window and follows it around. macOS only: window positions come from CoreGraphics.

use super::devices::{adb_binary, ios_simulators_blocking, running_avds};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;

const DOCK_WIDTH: f64 = 48.0;
const DOCK_HEIGHT: f64 = 292.0;
/// Size and lifetime of the toast shown over the centre of the device window
const TOAST_WIDTH: f64 = 320.0;
const TOAST_HEIGHT: f64 = 48.0;
/// The "recording" pill shown near the top of the device window while recording
const INDICATOR_WIDTH: f64 = 116.0;
const INDICATOR_HEIGHT: f64 = 34.0;
const INDICATOR_TOP_MARGIN: f64 = 14.0;
const TOAST_MILLIS: u64 = 1600;
/// A toast that stays until another replaces it (e.g. "Processing…"), with a safety limit
const STICKY_TOAST_MILLIS: u64 = 120_000;

/// Shared by the quick bars: where each one's device window is, and its current toast.
#[derive(Default)]
pub struct DockState {
    /// Latest device window rect (x, y, width, height; CoreGraphics coordinates) per bar label
    device_rects: Mutex<HashMap<String, (f64, f64, f64, f64)>>,
    /// The toast window currently shown for each bar
    toasts: Mutex<HashMap<String, String>>,
}

static TOAST_COUNTER: AtomicU64 = AtomicU64::new(0);

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

pub(crate) fn percent_encode(value: &str) -> String {
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

    const GAP: f64 = 6.0;
    const POLL: Duration = Duration::from_millis(40);
    const PROCESS_SCAN_EVERY: Duration = Duration::from_secs(2);
    /// How long the device window may be gone before the bar closes itself
    const GONE_GRACE: Duration = Duration::from_secs(3);
    /// Smaller windows are toolbars, menu-bar strips and the like, not the device screen
    const MIN_DEVICE_WINDOW: f64 = 150.0;
    /// While the bar isn't on screen, how often to try ordering it above the device again
    const ORDER_RETRY: Duration = Duration::from_millis(500);

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
        toggle_existing: bool,
    ) -> Result<(), String> {
        let label = dock_label(&platform, &device_id);

        // Already open: manual toggle closes it; automatic open leaves it alone
        if let Some(window) = app.get_webview_window(&label) {
            if toggle_existing {
                window.close().map_err(|e| e.to_string())?;
            }
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
            // Not "always on top": the bar is kept just above its device window instead (see
            // run_follow_loop), so windows opened from it (logs, settings) can sit above the bar
            .skip_taskbar(true)
            .resizable(true)
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

    /// Moves a window so its top-left corner is at (x, y) in CoreGraphics coordinates.
    fn place_top_left(window: &tauri::WebviewWindow, x: f64, y: f64) {
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
                if let Ok(ptr) = target.ns_window() {
                    let ns_window = ptr as *mut Object;
                    if !ns_window.is_null() {
                        let _: () = msg_send![ns_window, setFrameTopLeftPoint: NSPoint::new(x, primary_frame.size.height - y)];
                    }
                }
            }
        });
    }

    /// Shows a short message over the centre of the device window the calling bar is docked to.
    /// The toast is click-through and closes itself.
    pub fn show_toast(bar: &tauri::WebviewWindow, message: &str, kind: &str, sticky: bool) -> Result<(), String> {
        let app = bar.app_handle().clone();
        let bar_label = bar.label().to_string();
        let state = app.state::<DockState>();

        let rect = state
            .device_rects
            .lock()
            .map_err(|e| e.to_string())?
            .get(&bar_label)
            .copied();
        let Some((dx, dy, dw, dh)) = rect else {
            return Ok(());
        };

        let label = format!("dock-toast-{}", TOAST_COUNTER.fetch_add(1, AtomicOrdering::Relaxed));
        let previous = state
            .toasts
            .lock()
            .map_err(|e| e.to_string())?
            .insert(bar_label, label.clone());
        if let Some(window) = previous.and_then(|l| app.get_webview_window(&l)) {
            let _ = window.close();
        }

        let width = TOAST_WIDTH.min((dw - 24.0).max(120.0));
        let url = format!(
            "index.html?view=toast&kind={}&message={}",
            percent_encode(kind),
            percent_encode(message)
        );
        let toast = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("Quick bar")
            .inner_size(width, TOAST_HEIGHT)
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

        toast.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        place_top_left(&toast, dx + dw / 2.0 - width / 2.0, dy + dh / 2.0 - TOAST_HEIGHT / 2.0);
        toast.show().map_err(|e| e.to_string())?;

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(if sticky { STICKY_TOAST_MILLIS } else { TOAST_MILLIS }));
            let _ = toast.close();
        });
        Ok(())
    }

    /// Puts `target` immediately to the right of `anchor` (top edges aligned), kept inside the
    /// visible area of the display the anchor is on. Works in AppKit coordinates throughout, so it
    /// is right on any display arrangement.
    pub fn place_beside(target: &tauri::WebviewWindow, anchor: &tauri::WebviewWindow) {
        let (target, anchor) = (target.clone(), anchor.clone());
        let handle = target.clone();
        let _ = handle.run_on_main_thread(move || {
            use cocoa::foundation::{NSPoint, NSRect};
            use objc::{class, msg_send, runtime::Object, sel, sel_impl};

            let (Ok(target_ptr), Ok(anchor_ptr)) = (target.ns_window(), anchor.ns_window()) else {
                return;
            };
            let (target_ns, anchor_ns) = (target_ptr as *mut Object, anchor_ptr as *mut Object);
            if target_ns.is_null() || anchor_ns.is_null() {
                return;
            }

            unsafe {
                let anchor_frame: NSRect = msg_send![anchor_ns, frame];
                let target_frame: NSRect = msg_send![target_ns, frame];

                // Visible area (no menu bar / Dock) of the display the anchor is on
                let screens: *mut Object = msg_send![class!(NSScreen), screens];
                let count: usize = msg_send![screens, count];
                if count == 0 {
                    return;
                }
                let center_x = anchor_frame.origin.x + anchor_frame.size.width / 2.0;
                let center_y = anchor_frame.origin.y + anchor_frame.size.height / 2.0;
                let first: *mut Object = msg_send![screens, objectAtIndex: 0usize];
                let mut visible: NSRect = msg_send![first, visibleFrame];
                for i in 0..count {
                    let screen: *mut Object = msg_send![screens, objectAtIndex: i];
                    let frame: NSRect = msg_send![screen, frame];
                    if center_x >= frame.origin.x
                        && center_x < frame.origin.x + frame.size.width
                        && center_y >= frame.origin.y
                        && center_y < frame.origin.y + frame.size.height
                    {
                        visible = msg_send![screen, visibleFrame];
                        break;
                    }
                }

                // Right of the anchor, then pulled back inside the visible area
                let max_x = visible.origin.x + visible.size.width - target_frame.size.width;
                let x = (anchor_frame.origin.x + anchor_frame.size.width + GAP).min(max_x).max(visible.origin.x);
                let top = (anchor_frame.origin.y + anchor_frame.size.height)
                    .min(visible.origin.y + visible.size.height)
                    .max(visible.origin.y + target_frame.size.height);

                let _: () = msg_send![target_ns, setFrameTopLeftPoint: NSPoint::new(x, top)];
            }
        });
    }

    /// Shows `window` (without activating the app) directly above the window with this number,
    /// which may belong to another app. Done through AppKit's relative ordering.
    fn order_above(window: &tauri::WebviewWindow, other_number: i64) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc::{msg_send, runtime::Object, sel, sel_impl};

            if let Ok(ptr) = target.ns_window() {
                let ns_window = ptr as *mut Object;
                if !ns_window.is_null() {
                    const NS_WINDOW_ABOVE: i64 = 1;
                    let _: () = unsafe { msg_send![ns_window, orderWindow: NS_WINDOW_ABOVE relativeTo: other_number] };
                }
            }
        });
    }

    fn indicator_label(bar_label: &str) -> String {
        format!("dock-rec-{}", bar_label)
    }

    /// Shows the "recording" pill near the top of the device window the calling bar is docked to.
    pub fn show_indicator(bar: &tauri::WebviewWindow, started_at: u64) -> Result<(), String> {
        let app = bar.app_handle().clone();
        let label = indicator_label(bar.label());
        if app.get_webview_window(&label).is_some() {
            return Ok(());
        }

        let rect = app
            .state::<DockState>()
            .device_rects
            .lock()
            .map_err(|e| e.to_string())?
            .get(bar.label())
            .copied();
        let Some((dx, dy, dw, _)) = rect else {
            return Ok(());
        };

        let url = format!("index.html?view=recording&start={}", started_at);
        let indicator = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("Recording")
            .inner_size(INDICATOR_WIDTH, INDICATOR_HEIGHT)
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

        indicator.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        place_top_left(&indicator, dx + dw / 2.0 - INDICATOR_WIDTH / 2.0, dy + INDICATOR_TOP_MARGIN);
        indicator.show().map_err(|e| e.to_string())
    }

    pub fn hide_indicator(bar: &tauri::WebviewWindow) {
        let app = bar.app_handle();
        if let Some(window) = app.get_webview_window(&indicator_label(bar.label())) {
            let _ = window.close();
        }
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
        let mut avd_pids: Vec<i32> = Vec::new();
        let mut last_scan: Option<Instant> = None;
        let mut gone_since: Option<Instant> = None;
        let mut shown = false;
        let mut last_pos: Option<(f64, f64, f64)> = None;
        let mut last_order: Option<Instant> = None;

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
                    if let Some(indicator) = window.app_handle().get_webview_window(&indicator_label(window.label())) {
                        let _ = indicator.hide();
                    }
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
                        break;
                    }
                }
                continue;
            };
            gone_since = None;

            if last_pos != Some((device.x, device.y, right)) {
                place(&window, &device, right);
                last_pos = Some((device.x, device.y, right));
                if let Ok(mut rects) = window.app_handle().state::<DockState>().device_rects.lock() {
                    rects.insert(window.label().to_string(), (device.x, device.y, device.w, device.h));
                }
                if let Some(indicator) = window.app_handle().get_webview_window(&indicator_label(window.label())) {
                    place_top_left(
                        &indicator,
                        device.x + device.w / 2.0 - INDICATOR_WIDTH / 2.0,
                        device.y + INDICATOR_TOP_MARGIN,
                    );
                }
                debug(&format!(
                    "device window #{} '{}' at ({}, {}) {}x{}, bar anchored at right edge {}",
                    device.number, device.name, device.x, device.y, device.w, device.h, right
                ));
            }

            // Keep the bar directly above the device window: when the device is raised (clicked)
            // it ends up above the bar, so put the bar back. Anything else stacked above the
            // device, such as a logs window opened from the bar, stays above the bar too.
            let index_of = |number: i64| on_screen.iter().position(|w| w.number == number);
            let bar_index = own_number.and_then(index_of);
            let device_index = index_of(device.number);
            let behind_device = matches!((bar_index, device_index), (Some(bar), Some(dev)) if bar > dev);
            let not_on_screen = bar_index.is_none();
            let retry_due = last_order.map_or(true, |t| t.elapsed() >= ORDER_RETRY);

            if behind_device || (not_on_screen && retry_due) {
                last_order = Some(Instant::now());
                if own_number.is_some() {
                    order_above(&window, device.number);
                } else {
                    let _ = window.show();
                }
                if !shown {
                    if let Some(indicator) = window.app_handle().get_webview_window(&indicator_label(window.label())) {
                        let _ = indicator.show();
                    }
                    shown = true;
                    debug("bar shown above the device window");
                }
            }
        }

        if let Ok(mut rects) = window.app_handle().state::<DockState>().device_rects.lock() {
            rects.remove(window.label());
        }
        hide_indicator(&window);
    }
}

/// Moves `target` to just right of the quick bar `bar`, if `bar` is one. No-op elsewhere.
pub fn place_beside_bar(target: &tauri::WebviewWindow, bar: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    if bar.label().starts_with("dock-") {
        follow::place_beside(target, bar);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (target, bar);
}

/// Shows a toast over the centre of the device the calling quick bar is docked to.
/// `kind` is "ok", "error" or "busy" (a spinner).
#[tauri::command]
pub async fn show_device_toast(
    window: tauri::WebviewWindow,
    message: String,
    kind: String,
    sticky: Option<bool>,
) -> Result<(), String> {
    if !window.label().starts_with("dock-") {
        return Err("Not a quick bar window".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        follow::show_toast(&window, &message, &kind, sticky.unwrap_or(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (message, kind, sticky);
        Ok(())
    }
}

/// Shows the "recording" timer pill on the device the calling quick bar is docked to.
#[tauri::command]
pub async fn show_recording_indicator(window: tauri::WebviewWindow, started_at: u64) -> Result<(), String> {
    if !window.label().starts_with("dock-") {
        return Err("Not a quick bar window".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        follow::show_indicator(&window, started_at)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = started_at;
        Ok(())
    }
}

#[tauri::command]
pub async fn hide_recording_indicator(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("dock-") {
        return Err("Not a quick bar window".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        follow::hide_indicator(&window);
    }
    Ok(())
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
        follow::open(app, platform, device_id, device_name, true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, device_name);
        Err("The quick actions bar is only available on macOS".to_string())
    }
}

#[tauri::command]
pub async fn open_running_device_docks(app: tauri::AppHandle) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    {
        let (ios_devices, android_devices) = tokio::task::spawn_blocking(|| {
            let ios = ios_simulators_blocking()?
                .into_iter()
                .filter(|device| matches!(device.state.as_deref(), Some("Booted") | Some("Booting")))
                .map(|device| ("ios".to_string(), device.id, device.name))
                .collect::<Vec<_>>();
            let android = running_avds()
                .into_iter()
                .map(|(_serial, avd_name)| ("android".to_string(), avd_name.clone(), avd_name.replace('_', " ")))
                .collect::<Vec<_>>();
            Ok::<_, String>((ios, android))
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))??;

        let mut opened = 0;
        for (platform, device_id, device_name) in ios_devices.into_iter().chain(android_devices) {
            follow::open(app.clone(), platform, device_id, device_name, false)?;
            opened += 1;
        }
        Ok(opened)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(0)
    }
}

// ============ Quick actions ============

pub(crate) fn android_serial(avd_name: &str) -> Result<String, String> {
    running_avds()
        .into_iter()
        .find(|(_, name)| name == avd_name)
        .map(|(serial, _)| serial)
        .ok_or_else(|| "Emulator is not running".to_string())
}

pub(crate) fn run(command: &mut Command, what: &str) -> Result<Vec<u8>, String> {
    let output = command.output().map_err(|e| format!("Failed to {}: {}", what, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() { format!("Failed to {}", what) } else { detail.to_string() });
    }
    Ok(output.stdout)
}

pub(crate) fn simctl(args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    run(Command::new("xcrun").arg("simctl").args(args), what)
}

pub(crate) fn adb(serial: &str, args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    run(Command::new(adb_binary()).args(["-s", serial]).args(args), what)
}

fn valid_app_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

fn android_package_from_focus_line(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let token = token.trim_matches(|c: char| matches!(c, '{' | '}' | ')' | '(' | '[' | ']'));
        let Some((package, _activity)) = token.split_once('/') else {
            continue;
        };
        let package = package
            .rsplit_once(' ')
            .map(|(_, package)| package)
            .unwrap_or(package)
            .trim_matches(|c: char| matches!(c, '{' | '}' | ':' | '='));
        if valid_app_identifier(package) {
            return Some(package.to_string());
        }
    }
    None
}

pub(crate) fn current_android_package(serial: &str) -> Result<String, String> {
    let window = adb(serial, &["shell", "dumpsys", "window"], "read the focused Android app")?;
    let window_text = String::from_utf8_lossy(&window);
    for line in window_text.lines() {
        if (line.contains("mCurrentFocus") || line.contains("mFocusedApp"))
            && android_package_from_focus_line(line).is_some()
        {
            return Ok(android_package_from_focus_line(line).unwrap());
        }
    }

    let activity = adb(serial, &["shell", "dumpsys", "activity", "activities"], "read the resumed Android app")?;
    let activity_text = String::from_utf8_lossy(&activity);
    for line in activity_text.lines() {
        if (line.contains("topResumedActivity") || line.contains("mResumedActivity"))
            && android_package_from_focus_line(line).is_some()
        {
            return Ok(android_package_from_focus_line(line).unwrap());
        }
    }

    Err("Could not find the current Android app".to_string())
}

fn host_uid() -> Result<String, String> {
    let output = run(Command::new("id").arg("-u"), "read the current user id")?;
    let uid = String::from_utf8_lossy(&output).trim().to_string();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return Err("Could not read the current user id".to_string());
    }
    Ok(uid)
}

fn bundle_id_from_launchctl(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(&output);
    let mut bundle_ids: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let start = line.find("UIKitApplication:")? + "UIKitApplication:".len();
            let value = line[start..]
                .split(|c: char| c == '[' || c.is_whitespace())
                .next()?
                .trim();
            if value.starts_with("com.apple.") || !valid_app_identifier(value) {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect();
    bundle_ids.sort();
    bundle_ids.dedup();
    bundle_ids.into_iter().next()
}

pub(crate) fn current_ios_bundle_id(device_id: &str) -> Result<String, String> {
    let uid = host_uid()?;
    let user_domain = format!("user/{}", uid);
    if let Ok(output) = simctl(
        &["spawn", device_id, "launchctl", "print", &user_domain],
        "read the running simulator apps",
    ) {
        if let Some(bundle_id) = bundle_id_from_launchctl(&output) {
            return Ok(bundle_id);
        }
    }

    let output = simctl(
        &["spawn", device_id, "launchctl", "print", "system"],
        "read the running simulator apps",
    )?;
    bundle_id_from_launchctl(&output).ok_or_else(|| "Could not find a running simulator app".to_string())
}

fn relaunch_current_app(ios: bool, device_id: &str) -> Result<String, String> {
    if ios {
        let bundle_id = current_ios_bundle_id(device_id)?;
        let _ = simctl(&["terminate", device_id, &bundle_id], "terminate the simulator app");
        simctl(&["launch", device_id, &bundle_id], "launch the simulator app")?;
        Ok(bundle_id)
    } else {
        let serial = android_serial(device_id)?;
        let package = current_android_package(&serial)?;
        adb(&serial, &["shell", "am", "force-stop", &package], "stop the Android app")?;
        adb(
            &serial,
            &["shell", "monkey", "-p", &package, "-c", "android.intent.category.LAUNCHER", "1"],
            "launch the Android app",
        )?;
        Ok(package)
    }
}

/// A new file in the temp folder for a screenshot on its way to the clipboard.
fn screenshot_temp_path(device_id: &str) -> Result<PathBuf, String> {
    let name: String = device_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("grovr-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create a temp folder: {}", e))?;
    Ok(dir.join(format!("{}-{}.png", name, millis)))
}

/// Puts a PNG file on the clipboard as an image, so it can be pasted into chats, issues, etc.
/// Done by `osascript` rather than in-process: NSPasteboard must not be touched from a worker
/// thread (see clipboard.rs), and this needs no image-decoding dependency.
fn copy_png_to_clipboard(path: &std::path::Path) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Copying a screenshot is only available on macOS".to_string());
    }
    run(
        Command::new("osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "set the clipboard to (read (POSIX file (item 1 of argv)) as \u{ab}class PNGf\u{bb})",
                "-e",
                "end run",
            ])
            .arg(path),
        "copy the screenshot to the clipboard",
    )?;
    Ok(())
}

fn app_settings_save_to_desktop(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.state::<super::settings::SettingsState>()
        .0
        .lock()
        .map(|settings| settings.quick_bar.screenshot_save_to_desktop)
        .unwrap_or(false)
}

/// Best effort: a failure here shouldn't stop the screenshot reaching the clipboard.
fn save_screenshot_to_desktop(screenshot: &std::path::Path) {
    let (Some(home), Some(name)) = (std::env::var_os("HOME"), screenshot.file_name()) else {
        return;
    };
    let _ = std::fs::copy(screenshot, PathBuf::from(home).join("Desktop").join(name));
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
/// the new mode for `toggle_appearance`.
#[tauri::command]
pub async fn device_quick_action(
    app: tauri::AppHandle,
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
                let path = screenshot_temp_path(&device_id)?;
                let path_str = path.to_string_lossy().to_string();
                let result = (|| {
                    if ios {
                        simctl(&["io", &device_id, "screenshot", &path_str], "take a screenshot")?;
                    } else {
                        let serial = android_serial(&device_id)?;
                        let png = adb(&serial, &["exec-out", "screencap", "-p"], "take a screenshot")?;
                        std::fs::write(&path, png).map_err(|e| format!("Failed to save the screenshot: {}", e))?;
                    }
                    if app_settings_save_to_desktop(&app) {
                        save_screenshot_to_desktop(&path);
                    }
                    copy_png_to_clipboard(&path)
                })();
                // The clipboard holds its own copy of the image
                let _ = std::fs::remove_file(&path);
                result?;
                Ok(None)
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
            "relaunch_app" => relaunch_current_app(ios, &device_id).map(Some),
            _ => Err("Unknown action".to_string()),
        }
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
