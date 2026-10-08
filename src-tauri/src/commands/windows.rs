use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const JSON_VIEWER_LABEL: &str = "json-viewer";

/// Opens the JSON viewer in its own resizable window, or focuses it if already open.
#[tauri::command]
pub async fn open_json_viewer(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(JSON_VIEWER_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        JSON_VIEWER_LABEL,
        WebviewUrl::App("index.html?view=json".into()),
    )
    .title("JSON Viewer")
    .inner_size(1100.0, 720.0)
    .min_inner_size(640.0, 400.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

const QUICK_BAR_SETTINGS_LABEL: &str = "quickbar-settings";

fn quick_bar_settings_url(window: &tauri::WebviewWindow) -> String {
    let mut url = "index.html?view=quickbar-settings".to_string();
    if let Ok(source) = window.url() {
        for key in ["platform", "id", "name"] {
            if let Some(value) = source.query_pairs().find_map(|(query_key, value)| (query_key == key).then_some(value)) {
                url.push('&');
                url.push_str(key);
                url.push('=');
                url.push_str(&super::dock::percent_encode(&value));
            }
        }
    }
    url
}

/// Opens the quick bar settings (screenshot / recording options and saved recordings) to the
/// right of the quick bar that asked for it, or focuses it (moving it there) if already open.
#[tauri::command]
pub async fn open_quick_bar_settings(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let settings_url = quick_bar_settings_url(&window);
    if let Some(existing) = app.get_webview_window(QUICK_BAR_SETTINGS_LABEL) {
        let _ = existing.unminimize();
        let _ = existing.eval(&format!("window.location.replace('{}')", settings_url));
        super::dock::place_beside_bar(&existing, &window);
        existing.show().map_err(|e| e.to_string())?;
        let _ = existing.set_focus();
        return Ok(());
    }

    // Built hidden so it never flashes up somewhere else before being moved beside the bar
    let settings = WebviewWindowBuilder::new(
        &app,
        QUICK_BAR_SETTINGS_LABEL,
        WebviewUrl::App(settings_url.into()),
    )
    .title("Quick bar settings")
    .inner_size(880.0, 640.0)
    .min_inner_size(640.0, 420.0)
    .resizable(true)
    .center()
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    super::dock::place_beside_bar(&settings, &window);
    settings.show().map_err(|e| e.to_string())?;
    let _ = settings.set_focus();
    Ok(())
}
