use tauri_plugin_opener::OpenerExt;

/// Schemes that can run code or read local files; never opened from a saved link.
const BLOCKED_SCHEMES: [&str; 5] = ["file", "javascript", "data", "vbscript", "blob"];

fn scheme_of(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once(':')?;
    let valid = !scheme.is_empty()
        && scheme.chars().next()?.is_ascii_alphabetic()
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    valid.then(|| scheme.to_ascii_lowercase())
}

/// Opens a link with the system handler. Unlike the frontend opener (http/https/mailto/tel only),
/// this also supports custom app schemes such as `myapp://login`.
pub fn open_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let url = url.trim();
    let scheme = scheme_of(url).ok_or("Link must start with a scheme, e.g. https://")?;
    if BLOCKED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("Opening {}: links is not allowed", scheme));
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_url(&app, &url)
}
