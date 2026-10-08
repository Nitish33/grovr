use super::devices::{ios_simulators_blocking, running_avds};
use super::dock::{adb, android_serial, current_android_package, current_ios_bundle_id, simctl};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize)]
pub struct CurrentRunningApp {
    pub platform: String,
    pub device_id: String,
    pub device_name: String,
    pub app_id: String,
    pub app_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionAction {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppPermission {
    pub id: String,
    pub label: String,
    pub description: String,
    pub status: String,
    pub actions: Vec<PermissionAction>,
}

#[derive(Debug, Clone)]
struct PermissionDef {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    ios_service: Option<&'static str>,
    ios_tcc_service: Option<&'static str>,
    ios_usage_keys: &'static [&'static str],
    android_permissions: &'static [&'static str],
}

const PERMISSIONS: &[PermissionDef] = &[
    PermissionDef {
        id: "camera",
        label: "Camera",
        description: "Camera capture access.",
        ios_service: Some("camera"),
        ios_tcc_service: Some("kTCCServiceCamera"),
        ios_usage_keys: &["NSCameraUsageDescription"],
        android_permissions: &["android.permission.CAMERA"],
    },
    PermissionDef {
        id: "microphone",
        label: "Microphone",
        description: "Audio recording access.",
        ios_service: Some("microphone"),
        ios_tcc_service: Some("kTCCServiceMicrophone"),
        ios_usage_keys: &["NSMicrophoneUsageDescription"],
        android_permissions: &["android.permission.RECORD_AUDIO"],
    },
    PermissionDef {
        id: "location",
        label: "Location",
        description: "Foreground location access.",
        ios_service: Some("location"),
        ios_tcc_service: Some("kTCCServiceLocation"),
        ios_usage_keys: &[
            "NSLocationWhenInUseUsageDescription",
            "NSLocationAlwaysAndWhenInUseUsageDescription",
            "NSLocationAlwaysUsageDescription",
        ],
        android_permissions: &[
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
        ],
    },
    PermissionDef {
        id: "contacts",
        label: "Contacts",
        description: "Address book access.",
        ios_service: Some("contacts"),
        ios_tcc_service: Some("kTCCServiceAddressBook"),
        ios_usage_keys: &["NSContactsUsageDescription"],
        android_permissions: &["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
    },
    PermissionDef {
        id: "calendar",
        label: "Calendar",
        description: "Calendar read/write access.",
        ios_service: Some("calendar"),
        ios_tcc_service: Some("kTCCServiceCalendar"),
        ios_usage_keys: &[
            "NSCalendarsUsageDescription",
            "NSCalendarsFullAccessUsageDescription",
            "NSCalendarsWriteOnlyAccessUsageDescription",
        ],
        android_permissions: &["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
    },
    PermissionDef {
        id: "photos",
        label: "Photos",
        description: "Photo library or media image access.",
        ios_service: Some("photos"),
        ios_tcc_service: Some("kTCCServicePhotos"),
        ios_usage_keys: &["NSPhotoLibraryUsageDescription"],
        android_permissions: &[
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_EXTERNAL_STORAGE",
        ],
    },
    PermissionDef {
        id: "photos-add",
        label: "Add Photos",
        description: "Permission to add items to the photo library.",
        ios_service: Some("photos-add"),
        ios_tcc_service: Some("kTCCServicePhotosAdd"),
        ios_usage_keys: &["NSPhotoLibraryAddUsageDescription"],
        android_permissions: &["android.permission.WRITE_EXTERNAL_STORAGE"],
    },
    PermissionDef {
        id: "media-library",
        label: "Media Library",
        description: "Music and media library access.",
        ios_service: Some("media-library"),
        ios_tcc_service: Some("kTCCServiceMediaLibrary"),
        ios_usage_keys: &["NSAppleMusicUsageDescription"],
        android_permissions: &[
            "android.permission.READ_MEDIA_AUDIO",
            "android.permission.READ_MEDIA_VIDEO",
        ],
    },
    PermissionDef {
        id: "motion",
        label: "Motion",
        description: "Motion and fitness data access.",
        ios_service: Some("motion"),
        ios_tcc_service: Some("kTCCServiceMotion"),
        ios_usage_keys: &["NSMotionUsageDescription"],
        android_permissions: &["android.permission.ACTIVITY_RECOGNITION"],
    },
    PermissionDef {
        id: "reminders",
        label: "Reminders",
        description: "Reminders access.",
        ios_service: Some("reminders"),
        ios_tcc_service: Some("kTCCServiceReminders"),
        ios_usage_keys: &["NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"],
        android_permissions: &[],
    },
];

static PERMISSION_STATUS_OVERRIDES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn override_key(platform: &str, device_id: &str, app_id: &str, permission_id: &str) -> String {
    format!("{}:{}:{}:{}", platform, device_id, app_id, permission_id)
}

fn set_status_override(platform: &str, device_id: &str, app_id: &str, permission_id: &str, status: &str) {
    let overrides = PERMISSION_STATUS_OVERRIDES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut overrides) = overrides.lock() {
        overrides.insert(override_key(platform, device_id, app_id, permission_id), status.to_string());
    }
}

fn status_override(platform: &str, device_id: &str, app_id: &str, permission_id: &str) -> Option<String> {
    PERMISSION_STATUS_OVERRIDES
        .get()
        .and_then(|overrides| overrides.lock().ok()?.get(&override_key(platform, device_id, app_id, permission_id)).cloned())
}

fn validate_platform(platform: &str) -> Result<(), String> {
    if platform == "ios" || platform == "android" {
        Ok(())
    } else {
        Err("Unknown platform".to_string())
    }
}

fn running_device(platform: &str, device_id: Option<&str>) -> Result<(String, String), String> {
    if platform == "ios" {
        let devices = ios_simulators_blocking()?;
        let device = devices
            .into_iter()
            .filter(|device| device.state.as_deref() == Some("Booted"))
            .find(|device| device_id.is_none_or(|id| device.id == id))
            .ok_or_else(|| "No booted simulator found".to_string())?;
        Ok((device.id, device.name))
    } else {
        let devices = running_avds();
        let (serial, avd) = devices
            .into_iter()
            .find(|(_, avd)| device_id.is_none_or(|id| avd == id))
            .ok_or_else(|| "No running emulator found".to_string())?;
        let _ = serial;
        Ok((avd.clone(), avd.replace('_', " ")))
    }
}

fn current_app_blocking(platform: &str, device_id: Option<&str>) -> Result<CurrentRunningApp, String> {
    validate_platform(platform)?;
    let (resolved_device_id, device_name) = running_device(platform, device_id)?;
    let app_id = if platform == "ios" {
        current_ios_bundle_id(&resolved_device_id)?
    } else {
        let serial = android_serial(&resolved_device_id)?;
        current_android_package(&serial)?
    };
    Ok(CurrentRunningApp {
        platform: platform.to_string(),
        device_id: resolved_device_id,
        device_name,
        app_name: app_id.clone(),
        app_id,
    })
}

#[tauri::command]
pub async fn current_running_app(platform: String, device_id: Option<String>) -> Result<CurrentRunningApp, String> {
    tokio::task::spawn_blocking(move || current_app_blocking(&platform, device_id.as_deref()))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn android_installed_apps(device_id: &str) -> Result<Vec<InstalledApp>, String> {
    let serial = android_serial(device_id)?;
    let output = adb(&serial, &["shell", "pm", "list", "packages", "-3"], "list installed Android apps")?;
    let mut apps: Vec<InstalledApp> = String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|package| InstalledApp { id: package.to_string(), name: package.to_string() })
        .collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.id == b.id);
    Ok(apps)
}

fn ios_installed_apps(device_id: &str) -> Result<Vec<InstalledApp>, String> {
    let listed = Command::new("xcrun")
        .args(["simctl", "listapps", device_id])
        .output()
        .map_err(|e| format!("Failed to list simulator apps: {}", e))?;
    if !listed.status.success() {
        return Err(String::from_utf8_lossy(&listed.stderr).trim().to_string());
    }

    let mut plutil = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    if let Some(mut stdin) = plutil.stdin.take() {
        stdin.write_all(&listed.stdout).map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    }
    let converted = plutil.wait_with_output().map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    let json: Value = serde_json::from_slice(&converted.stdout)
        .map_err(|e| format!("Failed to parse simulator app list: {}", e))?;

    let mut apps: Vec<InstalledApp> = json
        .as_object()
        .into_iter()
        .flat_map(|apps| apps.iter())
        .filter(|(_, app)| app["ApplicationType"] == "User")
        .filter_map(|(bundle_id, app)| {
            let id = app["CFBundleIdentifier"].as_str().unwrap_or(bundle_id).to_string();
            let name = app["CFBundleDisplayName"]
                .as_str()
                .or_else(|| app["CFBundleName"].as_str())
                .or_else(|| app["CFBundleExecutable"].as_str())
                .unwrap_or(&id)
                .to_string();
            Some(InstalledApp { id, name })
        })
        .collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.id == b.id);
    Ok(apps)
}

fn ios_app_metadata(device_id: &str) -> Result<Value, String> {
    let listed = Command::new("xcrun")
        .args(["simctl", "listapps", device_id])
        .output()
        .map_err(|e| format!("Failed to list simulator apps: {}", e))?;
    if !listed.status.success() {
        return Err(String::from_utf8_lossy(&listed.stderr).trim().to_string());
    }

    let mut plutil = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    if let Some(mut stdin) = plutil.stdin.take() {
        stdin.write_all(&listed.stdout).map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    }
    let converted = plutil.wait_with_output().map_err(|e| format!("Failed to convert simulator app list: {}", e))?;
    serde_json::from_slice(&converted.stdout).map_err(|e| format!("Failed to parse simulator app list: {}", e))
}

fn ios_app_bundle_path(device_id: &str, app_id: &str) -> Result<String, String> {
    let json = ios_app_metadata(device_id)?;
    let app = json
        .as_object()
        .and_then(|apps| apps.get(app_id))
        .ok_or_else(|| "App is not installed on this simulator".to_string())?;
    app["Path"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Could not locate app bundle path".to_string())
}

fn ios_declared_permission_ids(device_id: &str, app_id: &str) -> Option<HashSet<String>> {
    let bundle_path = ios_app_bundle_path(device_id, app_id).ok()?;
    let info_plist = std::path::PathBuf::from(bundle_path).join("Info.plist");
    let output = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", info_plist.to_string_lossy().as_ref()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: Value = serde_json::from_slice(&output.stdout).ok()?;
    let object = json.as_object()?;
    Some(
        PERMISSIONS
            .iter()
            .filter(|def| def.ios_usage_keys.iter().any(|key| object.contains_key(*key)))
            .map(|def| def.id.to_string())
            .collect(),
    )
}

fn android_requested_permissions(device_id: &str, app_id: &str) -> Option<HashSet<String>> {
    let serial = android_serial(device_id).ok()?;
    let output = adb(&serial, &["shell", "dumpsys", "package", app_id], "read Android package permissions").ok()?;
    let package = String::from_utf8_lossy(&output);
    let mut requested = HashSet::new();
    let mut in_requested = false;
    for line in package.lines() {
        let trimmed = line.trim();
        if trimmed == "requested permissions:" {
            in_requested = true;
            continue;
        }
        if in_requested && (trimmed.ends_with("permissions:") || trimmed.starts_with("User ")) {
            break;
        }
        if in_requested && !trimmed.is_empty() {
            requested.insert(trimmed.to_string());
        }
    }
    Some(requested)
}

fn android_declared_permission_ids(device_id: &str, app_id: &str) -> Option<HashSet<String>> {
    let requested = android_requested_permissions(device_id, app_id)?;
    Some(
        PERMISSIONS
            .iter()
            .filter(|def| def.android_permissions.iter().any(|permission| requested.contains(*permission)))
            .map(|def| def.id.to_string())
            .collect(),
    )
}

fn declared_permission_ids(platform: &str, device_id: &str, app_id: &str) -> Option<HashSet<String>> {
    if platform == "ios" {
        ios_declared_permission_ids(device_id, app_id)
    } else {
        android_declared_permission_ids(device_id, app_id)
    }
}

#[tauri::command]
pub async fn list_installed_apps(platform: String, device_id: String) -> Result<Vec<InstalledApp>, String> {
    tokio::task::spawn_blocking(move || {
        validate_platform(&platform)?;
        if platform == "ios" {
            ios_installed_apps(&device_id)
        } else {
            android_installed_apps(&device_id)
        }
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn ios_tcc_db(device_id: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/Developer/CoreSimulator/Devices")
            .join(device_id)
            .join("data/Library/TCC/TCC.db")
            .to_string_lossy()
            .to_string(),
    )
}

fn sql_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn ios_permission_status(device_id: &str, app_id: &str, def: &PermissionDef) -> String {
    if def.id == "location" {
        if let Some(status) = status_override("ios", device_id, app_id, def.id) {
            return status;
        }
    }
    let Some(service) = def.ios_tcc_service else {
        return "unsupported".to_string();
    };
    let Some(db) = ios_tcc_db(device_id) else {
        return "unknown".to_string();
    };
    let query = format!(
        "select auth_value from access where client='{}' and service='{}' order by last_modified desc limit 1;",
        sql_escape(app_id),
        sql_escape(service),
    );
    let Ok(output) = Command::new("sqlite3").args([&db, &query]).output() else {
        return "unknown".to_string();
    };
    match String::from_utf8_lossy(&output.stdout).trim() {
        "0" => "denied".to_string(),
        "1" => "unknown".to_string(),
        "2" => {
            if def.id == "location" {
                "while_in_use".to_string()
            } else {
                "granted".to_string()
            }
        }
        "3" => "limited".to_string(),
        "" => "not_requested".to_string(),
        _ => "unknown".to_string(),
    }
}

fn android_permission_status(device_id: &str, app_id: &str, def: &PermissionDef) -> String {
    if def.android_permissions.is_empty() {
        return "unsupported".to_string();
    }
    let Ok(serial) = android_serial(device_id) else {
        return "unknown".to_string();
    };
    let Ok(output) = adb(&serial, &["shell", "dumpsys", "package", app_id], "read Android package permissions") else {
        return "unknown".to_string();
    };
    let package = String::from_utf8_lossy(&output);
    let mut saw_granted = false;
    let mut saw_denied = false;
    for permission in def.android_permissions {
        for line in package.lines() {
            let line = line.trim();
            if !line.starts_with(permission) || !line.contains("granted=") {
                continue;
            }
            if line.contains("granted=true") {
                saw_granted = true;
            } else {
                saw_denied = true;
            }
            break;
        }
    }
    match (saw_granted, saw_denied) {
        (true, false) => "granted".to_string(),
        (true, true) => "partial".to_string(),
        (false, true) => "denied".to_string(),
        _ => "unsupported".to_string(),
    }
}

fn actions_for(platform: &str, def: &PermissionDef) -> Vec<PermissionAction> {
    if platform == "ios" {
        vec![
            PermissionAction { id: "grant".to_string(), label: "Grant".to_string(), enabled: def.ios_service.is_some() },
            PermissionAction { id: "deny".to_string(), label: "Deny".to_string(), enabled: def.ios_service.is_some() },
            PermissionAction { id: "revoke".to_string(), label: "Revoke".to_string(), enabled: def.ios_service.is_some() },
            PermissionAction { id: "while_in_use".to_string(), label: "While in use".to_string(), enabled: def.id == "location" },
            PermissionAction { id: "only_this_time".to_string(), label: "Only this time".to_string(), enabled: false },
        ]
    } else {
        let supported = !def.android_permissions.is_empty();
        vec![
            PermissionAction { id: "grant".to_string(), label: "Grant".to_string(), enabled: supported },
            PermissionAction { id: "deny".to_string(), label: "Deny".to_string(), enabled: supported },
            PermissionAction { id: "revoke".to_string(), label: "Revoke".to_string(), enabled: supported },
            PermissionAction { id: "while_in_use".to_string(), label: "While in use".to_string(), enabled: def.id == "location" },
            PermissionAction { id: "only_this_time".to_string(), label: "Only this time".to_string(), enabled: false },
        ]
    }
}

fn list_permissions_blocking(platform: &str, device_id: &str, app_id: &str) -> Result<Vec<AppPermission>, String> {
    validate_platform(platform)?;
    let declared = declared_permission_ids(platform, device_id, app_id);
    Ok(PERMISSIONS
        .iter()
        .filter(|def| declared.as_ref().is_none_or(|ids| ids.contains(def.id)))
        .map(|def| AppPermission {
            id: def.id.to_string(),
            label: def.label.to_string(),
            description: def.description.to_string(),
            status: if platform == "ios" {
                ios_permission_status(device_id, app_id, def)
            } else {
                android_permission_status(device_id, app_id, def)
            },
            actions: actions_for(platform, def),
        })
        .collect())
}

#[tauri::command]
pub async fn list_app_permissions(platform: String, device_id: String, app_id: String) -> Result<Vec<AppPermission>, String> {
    tokio::task::spawn_blocking(move || list_permissions_blocking(&platform, &device_id, &app_id))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn apply_ios_permission(device_id: &str, app_id: &str, def: &PermissionDef, action: &str) -> Result<(), String> {
    let Some(service) = def.ios_service else {
        return Err(format!("{} is not supported on iOS simulator", def.label));
    };
    match action {
        "grant" => {
            simctl(&["privacy", device_id, "grant", service, app_id], "grant simulator permission")?;
            if def.id == "location" {
                set_status_override("ios", device_id, app_id, def.id, "while_in_use");
            }
        }
        "deny" => {
            simctl(&["privacy", device_id, "revoke", service, app_id], "deny simulator permission")?;
            if def.id == "location" {
                set_status_override("ios", device_id, app_id, def.id, "denied");
            }
        }
        "revoke" => {
            simctl(&["privacy", device_id, "reset", service, app_id], "reset simulator permission")?;
            if def.id == "location" {
                set_status_override("ios", device_id, app_id, def.id, "not_requested");
            }
        }
        "while_in_use" if def.id == "location" => {
            simctl(&["privacy", device_id, "grant", "location", app_id], "grant simulator location permission")?;
            set_status_override("ios", device_id, app_id, def.id, "while_in_use");
        }
        "only_this_time" => return Err("Only this time is not scriptable on iOS simulator".to_string()),
        _ => return Err("Unsupported permission action".to_string()),
    };
    Ok(())
}

fn apply_android_permission(device_id: &str, app_id: &str, def: &PermissionDef, action: &str) -> Result<(), String> {
    if def.android_permissions.is_empty() {
        return Err(format!("{} is not supported on Android", def.label));
    }
    let serial = android_serial(device_id)?;
    match action {
        "grant" | "while_in_use" => {
            for permission in def.android_permissions {
                let _ = adb(&serial, &["shell", "pm", "grant", app_id, permission], "grant Android permission");
            }
        }
        "deny" | "revoke" => {
            for permission in def.android_permissions {
                let _ = adb(&serial, &["shell", "pm", "revoke", app_id, permission], "revoke Android permission");
            }
        }
        "only_this_time" => return Err("Only this time is not scriptable on Android emulator".to_string()),
        _ => return Err("Unsupported permission action".to_string()),
    };
    Ok(())
}

#[tauri::command]
pub async fn set_app_permission(
    platform: String,
    device_id: String,
    app_id: String,
    permission_id: String,
    action: String,
) -> Result<Vec<AppPermission>, String> {
    tokio::task::spawn_blocking(move || {
        validate_platform(&platform)?;
        let def = PERMISSIONS
            .iter()
            .find(|def| def.id == permission_id)
            .ok_or_else(|| "Unknown permission".to_string())?;
        if platform == "ios" {
            apply_ios_permission(&device_id, &app_id, def, &action)?;
        } else {
            apply_android_permission(&device_id, &app_id, def, &action)?;
        }
        list_permissions_blocking(&platform, &device_id, &app_id)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
