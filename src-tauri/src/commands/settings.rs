use crate::types::{AppSettings, DeepLinkItem, IdeConfig, NoteItem, QuickBarSettings, QuickLinkItem, WorktreeMemo};
use tauri::{Manager, State};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;
use std::sync::Mutex;

const STORE_PATH: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";

pub struct SettingsState(pub Mutex<AppSettings>);

fn load_settings(app: &tauri::AppHandle) -> AppSettings {
    let store = app.store(STORE_PATH).ok();
    store
        .and_then(|s| s.get(SETTINGS_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(
        SETTINGS_KEY,
        serde_json::to_value(settings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn init_settings(app: &tauri::AppHandle) -> SettingsState {
    SettingsState(Mutex::new(load_settings(app)))
}

#[tauri::command]
pub fn get_settings(state: State<SettingsState>) -> Result<AppSettings, String> {
    let settings = state.0.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
pub fn set_ide(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    ide: IdeConfig,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.ide = Some(ide);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_theme(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    theme: String,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.theme = theme;
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_launch_at_startup(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    // macOS: Use SMAppService for native login item management
    #[cfg(target_os = "macos")]
    {
        use smappservice_rs::{AppService, ServiceType};
        let app_service = AppService::new(ServiceType::MainApp);
        if enabled {
            app_service.register().map_err(|e| e.to_string())?;
        } else {
            app_service.unregister().map_err(|e| e.to_string())?;
        }
    }

    // Windows/Linux: Use tauri-plugin-autostart
    #[cfg(not(target_os = "macos"))]
    {
        let autostart_manager = app.autolaunch();
        if enabled {
            autostart_manager.enable().map_err(|e| e.to_string())?;
        } else {
            autostart_manager.disable().map_err(|e| e.to_string())?;
        }
    }

    // Save setting
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.launch_at_startup = Some(enabled);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_default_worktree_template(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    template: String,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.default_worktree_template = Some(template);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_copy_paths(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.copy_paths = Some(paths);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_fetch_before_create(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.fetch_before_create = Some(enabled);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_clipboard_parse_patterns(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    patterns: Vec<String>,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.clipboard_parse_patterns = Some(patterns);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_last_used_project(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    project: String,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.last_used_project = Some(project);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_refresh_interval_minutes(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    minutes: i32,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.refresh_interval_minutes = minutes;
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_skip_open_ide_confirm(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    skip: bool,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.skip_open_ide_confirm = Some(skip);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_onboarding_completed(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    completed: bool,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.onboarding_completed = Some(completed);
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn set_pinned_devices(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    pinned: Vec<String>,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.pinned_devices = pinned;
    save_settings(&app, &settings)
}

const MAX_DEVICE_NOTE_CHARS: usize = 200;

/// Sets (or, when blank, removes) the note for a device. Key is "ios:<udid>" or "android:<avd>".
#[tauri::command]
pub fn set_device_note(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    key: String,
    note: String,
) -> Result<(), String> {
    let note: String = note.trim().chars().take(MAX_DEVICE_NOTE_CHARS).collect();
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    if note.is_empty() {
        settings.device_notes.remove(&key);
    } else {
        settings.device_notes.insert(key, note);
    }
    save_settings(&app, &settings)
}

const MAX_NOTES: usize = 500;
const MAX_NOTE_TEXT_CHARS: usize = 10_000;

/// Replaces the full list of Notes-tab notes (pinned first, then by user order).
/// Blank notes are dropped and sizes are capped.
#[tauri::command]
pub fn set_notes(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    notes: Vec<NoteItem>,
) -> Result<(), String> {
    let cleaned: Vec<NoteItem> = notes
        .into_iter()
        .filter_map(|note| {
            let text: String = note.text.trim().chars().take(MAX_NOTE_TEXT_CHARS).collect();
            (!text.is_empty()).then_some(NoteItem { id: note.id, text, pinned: note.pinned })
        })
        .take(MAX_NOTES)
        .collect();

    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.notes = cleaned;
    save_settings(&app, &settings)
}

const MAX_QUICK_LINKS: usize = 500;
const MAX_LINK_NAME_CHARS: usize = 100;
const MAX_LINK_URL_CHARS: usize = 2_000;
const MAX_DEEP_LINKS: usize = 500;
const MAX_PACKAGE_CHARS: usize = 200;

/// Replaces the full list of Quick links (pinned first, then by user order).
/// Entries without a URL are dropped and sizes are capped.
#[tauri::command]
pub fn set_quick_links(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    links: Vec<QuickLinkItem>,
) -> Result<(), String> {
    let cleaned: Vec<QuickLinkItem> = links
        .into_iter()
        .filter_map(|link| {
            let url: String = link.url.trim().chars().take(MAX_LINK_URL_CHARS).collect();
            if url.is_empty() {
                return None;
            }
            let name: String = link.name.trim().chars().take(MAX_LINK_NAME_CHARS).collect();
            let name = if name.is_empty() { url.clone() } else { name };
            Some(QuickLinkItem { id: link.id, name, url, pinned: link.pinned })
        })
        .take(MAX_QUICK_LINKS)
        .collect();

    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.quick_links = cleaned;
    save_settings(&app, &settings)
}

/// Replaces the full list of app deep links used by the quick bar.
#[tauri::command]
pub fn set_deep_links(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    links: Vec<DeepLinkItem>,
) -> Result<(), String> {
    let cleaned: Vec<DeepLinkItem> = links
        .into_iter()
        .filter_map(|link| {
            let platform = match link.platform.as_str() {
                "ios" | "android" => link.platform,
                _ => "ios".to_string(),
            };
            let package: String = link.package.trim().chars().take(MAX_PACKAGE_CHARS).collect();
            let url: String = link.url.trim().chars().take(MAX_LINK_URL_CHARS).collect();
            if package.is_empty() || url.is_empty() {
                return None;
            }
            let name: String = link.name.trim().chars().take(MAX_LINK_NAME_CHARS).collect();
            let name = if name.is_empty() { url.clone() } else { name };
            Some(DeepLinkItem { id: link.id, platform, package, name, url })
        })
        .take(MAX_DEEP_LINKS)
        .collect();

    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.deep_links = cleaned;
    save_settings(&app, &settings)
}

#[tauri::command]
pub fn get_worktree_memo(
    state: State<SettingsState>,
    path: String,
) -> Result<WorktreeMemo, String> {
    let settings = state.0.lock().map_err(|e| e.to_string())?;
    Ok(settings.worktree_memos.get(&path).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn set_worktree_memo(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    path: String,
    memo: WorktreeMemo,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.worktree_memos.insert(path, memo);
    save_settings(&app, &settings)
}

fn toggle_window_visibility(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        if is_visible && is_focused {
            // Window is visible and focused -> hide it
            let _ = window.hide();
        } else {
            // Window is hidden or not focused -> show and focus
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

pub fn register_global_shortcut(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_window_visibility(&app_handle);
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_global_shortcut(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    shortcut: Option<String>,
) -> Result<(), String> {
    // 1. Unregister existing shortcut
    let old_shortcut = {
        let settings = state.0.lock().map_err(|e| e.to_string())?;
        settings.global_shortcut.clone()
    };

    if let Some(ref old) = old_shortcut {
        if let Ok(parsed) = old.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(parsed);
        }
    }

    // 2. Register new shortcut
    if let Some(ref new_shortcut) = shortcut {
        register_global_shortcut(&app, new_shortcut)?;
    }

    // 3. Save settings
    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.global_shortcut = shortcut;
    save_settings(&app, &settings)
}

const ALLOWED_FPS: [u32; 5] = [0, 15, 24, 30, 60];
const ALLOWED_TOUCH_COLORS: [&str; 5] = ["green", "blue", "yellow", "pink", "white"];

#[tauri::command]
pub fn set_quick_bar_settings(
    app: tauri::AppHandle,
    state: State<SettingsState>,
    quick_bar: QuickBarSettings,
) -> Result<(), String> {
    let cleaned = QuickBarSettings {
        video_crf: quick_bar.video_crf.clamp(18, 36),
        video_fps: if ALLOWED_FPS.contains(&quick_bar.video_fps) { quick_bar.video_fps } else { 30 },
        video_max_width: quick_bar.video_max_width.min(4096),
        video_codec: if quick_bar.video_codec == "hevc" { "hevc".to_string() } else { "h264".to_string() },
        recording_keep_hours: quick_bar.recording_keep_hours.min(24 * 365),
        recording_touch_color: if ALLOWED_TOUCH_COLORS.contains(&quick_bar.recording_touch_color.as_str()) {
            quick_bar.recording_touch_color
        } else {
            "green".to_string()
        },
        ..quick_bar
    };

    let mut settings = state.0.lock().map_err(|e| e.to_string())?;
    settings.quick_bar = cleaned;
    save_settings(&app, &settings)
}
