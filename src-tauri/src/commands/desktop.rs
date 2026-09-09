//! Desktop-only Tauri IPC adapters.

use tauri::{AppHandle, Manager, State};

use crate::{infrastructure::platform::desktop, sftp::SftpService};

#[tauri::command]
pub(crate) fn frontend_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.maximize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) fn get_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
pub(crate) fn read_app_log(kind: String) -> Result<desktop::AppLogSnapshot, String> {
    desktop::read_app_log(kind).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn append_frontend_log(lines: Vec<String>) -> Result<(), String> {
    desktop::append_frontend_log(lines).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn clear_app_log(kind: String) -> Result<(), String> {
    desktop::clear_app_log(kind).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn migrate_electron_settings() -> Option<serde_json::Value> {
    desktop::read_unmigrated()
}

#[tauri::command]
pub(crate) fn mark_electron_settings_migrated() -> Result<(), String> {
    desktop::mark_migrated().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn save_blob_to_disk(
    app: AppHandle,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || desktop::save_blob(&app, &bytes, &suggested_name))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn sftp_drag_out(
    service: State<'_, SftpService>,
    source_session_id: String,
    local_session_id: String,
    paths: Vec<String>,
) -> Result<desktop::DragOutFiles, String> {
    desktop::materialize_drag(service.inner(), source_session_id, local_session_id, paths)
        .await
        .map_err(|error| error.to_string())
}
