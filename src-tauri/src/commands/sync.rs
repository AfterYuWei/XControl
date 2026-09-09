//! Tauri IPC adapters for backup synchronization and cloud providers.

use serde::Serialize;
use tauri::State;

use crate::{
    error::CommandError,
    sync::{
        BackupNowResult, RestoreResult, SyncEvent, SyncProviderConfig, SyncProviderMeta,
        SyncService, SyncSettings, SyncStatus, SyncVersion, ORIGIN_MANUAL,
    },
};

#[derive(Serialize)]
pub(crate) struct SavedResult {
    saved: bool,
}

#[derive(Serialize)]
pub(crate) struct StartedResult {
    started: bool,
}

#[derive(Serialize)]
pub(crate) struct ResolvedResult {
    resolved: bool,
    version: Option<SyncVersion>,
}

#[derive(Serialize)]
pub(crate) struct PasswordResult {
    sync_password: String,
}

#[derive(Serialize)]
pub(crate) struct OAuthURLResult {
    url: String,
}

#[tauri::command]
pub(crate) async fn sync_status(
    service: State<'_, SyncService>,
) -> Result<SyncStatus, CommandError> {
    service.status().await
}

#[tauri::command]
pub(crate) async fn sync_backup_now(
    service: State<'_, SyncService>,
) -> Result<BackupNowResult, CommandError> {
    let owned = service.inner().clone();
    let version = tokio::task::spawn_blocking(move || owned.create_version(ORIGIN_MANUAL))
        .await
        .map_err(join_error)??;
    if version.is_some() {
        service.request_push()?;
    }
    Ok(BackupNowResult {
        created: version.is_some(),
        message: version
            .is_none()
            .then(|| "数据自上一版本以来没有变化".into()),
        version,
    })
}

#[tauri::command]
pub(crate) async fn sync_versions(
    service: State<'_, SyncService>,
) -> Result<Vec<SyncVersion>, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_versions())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_restore_version(
    service: State<'_, SyncService>,
    id: String,
) -> Result<RestoreResult, CommandError> {
    let owned = service.inner().clone();
    let version = tokio::task::spawn_blocking(move || owned.restore_version(&id))
        .await
        .map_err(join_error)??;
    service.request_push()?;
    Ok(RestoreResult {
        restored: true,
        version,
    })
}

#[tauri::command]
pub(crate) async fn sync_delete_version(
    service: State<'_, SyncService>,
    id: String,
    force: bool,
) -> Result<(), CommandError> {
    service.delete_version_with_cloud(&id, force).await
}

#[tauri::command]
pub(crate) async fn sync_events(
    service: State<'_, SyncService>,
    limit: Option<i64>,
) -> Result<Vec<SyncEvent>, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_events(limit.unwrap_or(50)))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_get_settings(
    service: State<'_, SyncService>,
) -> Result<SyncSettings, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.get_settings())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_update_settings(
    service: State<'_, SyncService>,
    mut settings: SyncSettings,
    sync_password: Option<String>,
) -> Result<SavedResult, CommandError> {
    settings.sync_password = sync_password.unwrap_or_default();
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.save_settings(settings))
        .await
        .map_err(join_error)??;
    service.reload_scheduler()?;
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub(crate) async fn sync_reveal_password(
    service: State<'_, SyncService>,
) -> Result<PasswordResult, CommandError> {
    let owned = service.inner().clone();
    let sync_password = tokio::task::spawn_blocking(move || owned.reveal_password())
        .await
        .map_err(join_error)??;
    Ok(PasswordResult { sync_password })
}

#[tauri::command]
pub(crate) async fn sync_shutdown(service: State<'_, SyncService>) -> Result<(), CommandError> {
    service.shutdown_backup().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_now(
    service: State<'_, SyncService>,
) -> Result<StartedResult, CommandError> {
    service.request_sync()?;
    Ok(StartedResult { started: true })
}

#[tauri::command]
pub(crate) async fn sync_push(
    service: State<'_, SyncService>,
) -> Result<StartedResult, CommandError> {
    service.request_push()?;
    Ok(StartedResult { started: true })
}

#[tauri::command]
pub(crate) async fn sync_resolve_conflict(
    service: State<'_, SyncService>,
    choice: String,
) -> Result<ResolvedResult, CommandError> {
    let version = service.resolve_conflict(&choice).await?;
    Ok(ResolvedResult {
        resolved: true,
        version,
    })
}

#[tauri::command]
pub(crate) async fn sync_providers(
    service: State<'_, SyncService>,
) -> Result<Vec<SyncProviderMeta>, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_providers())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_create_provider(
    service: State<'_, SyncService>,
    config: SyncProviderConfig,
) -> Result<SyncProviderMeta, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.create_provider(config))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_update_provider(
    service: State<'_, SyncService>,
    id: String,
    config: SyncProviderConfig,
) -> Result<SavedResult, CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.update_provider(&id, config))
        .await
        .map_err(join_error)??;
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub(crate) async fn sync_delete_provider(
    service: State<'_, SyncService>,
    id: String,
) -> Result<(), CommandError> {
    let owned = service.inner().clone();
    tokio::task::spawn_blocking(move || owned.delete_provider(&id))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn sync_test_provider(
    service: State<'_, SyncService>,
    id: String,
) -> Result<SavedResult, CommandError> {
    service.test_provider(&id).await?;
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub(crate) async fn sync_oauth_url(
    service: State<'_, SyncService>,
    provider_type: String,
    provider_id: String,
) -> Result<OAuthURLResult, CommandError> {
    let url = service.build_oauth_url(&provider_type, &provider_id)?;
    Ok(OAuthURLResult { url })
}

fn join_error(error: tokio::task::JoinError) -> CommandError {
    CommandError::new("SYNC_FAILED", format!("后台任务异常结束: {error}"))
}
