use tauri::{Manager, WindowEvent};

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;

mod commands;
mod secure_store;
mod types;

use commands::settings::{
    get_settings, get_worktree_memo, init_settings, register_global_shortcut,
    set_clipboard_parse_patterns, set_copy_paths, set_default_worktree_template,
    set_fetch_before_create, set_global_shortcut, set_ide, set_last_used_project,
    set_launch_at_startup, set_onboarding_completed, set_refresh_interval_minutes,
    set_skip_open_ide_confirm, set_theme, set_worktree_memo, set_pinned_devices,
    set_device_note, set_notes, set_quick_links, set_quick_bar_settings,
};
use commands::links::open_link;
use commands::windows::{open_json_viewer, open_quick_bar_settings};
use commands::recording::{
    start_device_recording, stop_device_recording, device_recording_started_at, list_recordings,
    delete_recording, delete_all_recordings, open_recording, reveal_recording, ffmpeg_location,
};
use commands::dock::{
    toggle_device_dock, device_quick_action, show_device_toast, show_recording_indicator,
    hide_recording_indicator, open_running_device_docks,
};
use commands::logs::{open_log_window, start_log_stream, save_log_snapshot, list_android_processes, list_user_apps};
use commands::devices::{
    list_ios_simulators, list_android_emulators, launch_ios_simulator, launch_android_emulator,
};
use commands::projects::{add_project, get_projects, remove_project, reorder_projects, update_project};
use commands::git::{
    get_worktrees, create_worktree, create_worktree_existing_branch, remove_worktree,
    prune_worktrees, get_worktree_status, get_branches, get_current_branch, get_default_branch,
    delete_branch, rename_branch, git_fetch, git_pull, get_github_remote_info, open_ide,
    open_in_finder, open_terminal, copy_paths_to_worktree, detect_native_projects,
    open_xcode, open_android_studio, run_start_command, get_worktree_git_status,
};
use commands::clipboard::read_clipboard_text;
use commands::integrations::{
    get_github_config, set_github_config, remove_github_config, validate_github_token,
    get_jira_config, set_jira_config, remove_jira_config, validate_jira_credentials,
    fetch_pull_requests, fetch_jira_issue,
};

fn setup_window_effects(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").expect("no main window");

    // Set dynamic window title for preview mode (worktree isolation)
    if let Ok(worktree) = std::env::var("GROVR_PREVIEW_WORKTREE") {
        window.set_title(&format!("DevTool ({})", worktree))?;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = apply_mica(&window, None);
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Plugins
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // The quick bars are positioned by the app beside a device window, and their settings
                // window opens beside the bar; restoring a saved position (or visibility) would fight that
                .with_filter(|label| !label.starts_with("dock-") && label != "quickbar-settings")
                .build(),
        )
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Only use autostart plugin on non-macOS (Windows/Linux)
    // macOS uses SMAppService via smappservice-rs for native login item management
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::AppleScript,
            None,
        ));
    }

    builder
        // Setup
        .setup(|app| {
            // Initialize settings state
            let settings_state = init_settings(app.handle());

            // Register saved global shortcut on startup
            if let Ok(settings) = settings_state.0.lock() {
                if let Some(ref shortcut) = settings.global_shortcut {
                    let _ = register_global_shortcut(app.handle(), shortcut);
                }
            }

            app.manage(settings_state);
            app.manage(commands::logs::LogStreams::default());
            app.manage(commands::dock::DockState::default());
            app.manage(commands::recording::Recordings::default());
            // A previous run may have been killed mid-recording
            std::thread::spawn(commands::recording::stop_orphans);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(750)).await;
                if let Err(err) = commands::dock::open_running_device_docks(handle).await {
                    eprintln!("[dock] failed to open running device quick bars: {}", err);
                }
            });

            // Apply window effects
            setup_window_effects(app)?;
            Ok(())
        })
        // Commands
        .invoke_handler(tauri::generate_handler![
            // Settings
            get_settings,
            set_ide,
            set_theme,
            set_launch_at_startup,
            set_default_worktree_template,
            set_copy_paths,
            set_fetch_before_create,
            set_clipboard_parse_patterns,
            set_last_used_project,
            set_refresh_interval_minutes,
            set_skip_open_ide_confirm,
            set_onboarding_completed,
            get_worktree_memo,
            set_worktree_memo,
            set_global_shortcut,
            set_pinned_devices,
            set_device_note,
            set_notes,
            set_quick_links,
            set_quick_bar_settings,
            // Projects
            get_projects,
            add_project,
            update_project,
            remove_project,
            reorder_projects,
            // Git - Worktrees
            get_worktrees,
            create_worktree,
            create_worktree_existing_branch,
            remove_worktree,
            prune_worktrees,
            get_worktree_status,
            // Git - Branches
            get_branches,
            get_current_branch,
            get_default_branch,
            delete_branch,
            rename_branch,
            // Git - Operations
            git_fetch,
            git_pull,
            // Git - Remote
            get_github_remote_info,
            // IDE/File
            open_ide,
            open_in_finder,
            open_terminal,
            copy_paths_to_worktree,
            detect_native_projects,
            open_xcode,
            open_android_studio,
            run_start_command,
            // Integrations - GitHub
            get_github_config,
            set_github_config,
            remove_github_config,
            validate_github_token,
            fetch_pull_requests,
            // Integrations - Jira
            get_jira_config,
            set_jira_config,
            remove_jira_config,
            validate_jira_credentials,
            fetch_jira_issue,
            // Devices
            list_ios_simulators,
            list_android_emulators,
            launch_ios_simulator,
            launch_android_emulator,
            // Links
            open_link,
            // Windows
            open_json_viewer,
            open_quick_bar_settings,
            open_log_window,
            toggle_device_dock,
            open_running_device_docks,
            device_quick_action,
            show_device_toast,
            show_recording_indicator,
            hide_recording_indicator,
            start_device_recording,
            stop_device_recording,
            device_recording_started_at,
            list_recordings,
            delete_recording,
            delete_all_recordings,
            open_recording,
            reveal_recording,
            ffmpeg_location,
            get_worktree_git_status,
            start_log_stream,
            save_log_snapshot,
            list_android_processes,
            list_user_apps,
            // Clipboard
            read_clipboard_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::recording::stop_all(app_handle);
            }

            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                if label == "main" && matches!(event, WindowEvent::Focused(true)) {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = commands::dock::open_running_device_docks(handle).await {
                            eprintln!("[dock] failed to open running device quick bars on focus: {}", err);
                        }
                    });
                }
            }

            // macOS: Show window when dock icon is clicked (Reopen event)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
