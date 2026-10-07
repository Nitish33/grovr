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
