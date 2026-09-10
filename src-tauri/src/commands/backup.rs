use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::{
    backup::{BackupImportResult, BackupPreview, BackupService},
    error::CommandError,
    infrastructure::platform::document_gateway::DocumentGateway,
    sync::SyncService,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPickedFile {
    name: String,
    reference: String,
}

#[cfg(desktop)]
fn backup_name() -> String {
    format!(
        "eizhu-backup-{}.eizhubackup",
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
) -> Result<Option<BackupPickedFile>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("eizhu 备份文件", &["eizhubackup", "xcbackup", "json"])
            .add_filter("所有文件", &["*"])
            .blocking_pick_file()
            .map(dialog_path)
            .transpose()
            .map(|path| {
                path.map(|value| BackupPickedFile {
                    name: value
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("backup")
                        .to_owned(),
                    reference: value.display().to_string(),
                })
            })
    })
    .await
    .map_err(CommandError::database)?
}

#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn backup_pick_file(
    app: tauri::AppHandle,
    gateway: State<'_, DocumentGateway>,
) -> Result<Option<BackupPickedFile>, CommandError> {
    Ok(gateway
        .pick(
            &app,
            false,
            vec!["application/octet-stream".into(), "application/json".into()],
        )?
        .into_iter()
        .next()
        .map(|document| BackupPickedFile {
            name: document.name,
            reference: document.reference,
        }))
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
            .add_filter("eizhu 备份文件", &["eizhubackup"])
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

#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn backup_export(
    app: tauri::AppHandle,
    gateway: State<'_, DocumentGateway>,
    service: State<'_, BackupService>,
    mode: String,
    password: Option<String>,
) -> Result<Option<String>, CommandError> {
    let service = service.inner().clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        service.export_bytes(&mode, password.as_deref().unwrap_or_default())
    })
    .await
    .map_err(CommandError::database)??;
    let name = format!(
        "eizhu-backup-{}.eizhubackup",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let path = gateway.write_export(&name, &bytes)?;
    let result = gateway.export_file(&app, &path, name, "application/octet-stream".into());
    let _ = std::fs::remove_file(path);
    result
}

fn resolve_backup_path(
    gateway: &DocumentGateway,
    reference: &str,
) -> Result<PathBuf, CommandError> {
    if reference.starts_with("document://") {
        return gateway.resolve(reference).map(|(path, _, _)| path);
    }
    Ok(Path::new(reference).to_path_buf())
}

#[tauri::command]
pub(crate) async fn backup_preview(
    service: State<'_, BackupService>,
    gateway: State<'_, DocumentGateway>,
    file_path: String,
    password: Option<String>,
) -> Result<BackupPreview, CommandError> {
    let service = service.inner().clone();
    let file_path = resolve_backup_path(gateway.inner(), &file_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        service.preview(
            &file_path.display().to_string(),
            password.as_deref().unwrap_or_default(),
        )
    })
    .await
    .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn backup_import(
    service: State<'_, BackupService>,
    gateway: State<'_, DocumentGateway>,
    sync: State<'_, SyncService>,
    file_path: String,
    strategy: String,
    password: Option<String>,
) -> Result<BackupImportResult, CommandError> {
    let service = service.inner().clone();
    let document_reference = file_path
        .starts_with("document://")
        .then_some(file_path.clone());
    let file_path = resolve_backup_path(gateway.inner(), &file_path)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.import(
            &file_path.display().to_string(),
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
    if let Some(reference) = document_reference {
        gateway.release(&reference)?;
    }
    sync.notify_change();
    Ok(result)
}
