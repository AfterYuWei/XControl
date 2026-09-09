use std::path::PathBuf;

use tauri::State;

use crate::{
    backup::{BackupImportResult, BackupPreview, BackupService},
    error::CommandError,
    sync::SyncState,
};

#[cfg(desktop)]
fn backup_name() -> String {
    format!(
        "xcontrol-backup-{}.xcbackup",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    )
}

#[cfg(desktop)]
fn dialog_path(path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, CommandError> {
    path.into_path()
        .map_err(|error| CommandError::new("FILE_ERROR", error.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn backup_pick_file(
    app: tauri::AppHandle,
) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("XControl 备份文件", &["xcbackup", "json"])
            .add_filter("所有文件", &["*"])
            .blocking_pick_file()
            .map(dialog_path)
            .transpose()
            .map(|path| path.map(|value| value.display().to_string()))
    })
    .await
    .map_err(CommandError::database)?
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn backup_export(
    app: tauri::AppHandle,
    service: State<'_, BackupService>,
    mode: String,
    password: Option<String>,
) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = service.export_bytes(&mode, password.as_deref().unwrap_or_default())?;
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name(backup_name())
            .add_filter("XControl 备份文件", &["xcbackup"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = dialog_path(path)?;
        std::fs::write(&path, bytes).map_err(|error| {
            CommandError::new("FILE_ERROR", format!("写入目标文件失败: {error}"))
        })?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn backup_preview(
    service: State<'_, BackupService>,
    file_path: String,
    password: Option<String>,
) -> Result<BackupPreview, CommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.preview(&file_path, password.as_deref().unwrap_or_default())
    })
    .await
    .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn backup_import(
    service: State<'_, BackupService>,
    sync: State<'_, SyncState>,
    file_path: String,
    strategy: String,
    password: Option<String>,
) -> Result<BackupImportResult, CommandError> {
    let service = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.import(
            &file_path,
            if strategy.is_empty() {
                "skip"
            } else {
                &strategy
            },
            password.as_deref().unwrap_or_default(),
        )
    })
    .await
    .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(result)
}
