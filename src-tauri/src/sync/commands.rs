use serde::Serialize;
use tauri::State;

use crate::error::CommandError;

use super::{
    manager::{BackupNowResult, RestoreResult, SyncState, ORIGIN_MANUAL},
    model::{
        SyncEvent, SyncProviderConfig, SyncProviderMeta, SyncSettings, SyncStatus, SyncVersion,
    },
};

#[derive(Serialize)]
pub struct SavedResult {
    saved: bool,
}

#[derive(Serialize)]
pub struct StartedResult {
    started: bool,
}

#[derive(Serialize)]
pub struct ResolvedResult {
    resolved: bool,
    version: Option<SyncVersion>,
}

#[derive(Serialize)]
pub struct PasswordResult {
    sync_password: String,
}

#[derive(Serialize)]
pub struct OAuthURLResult {
    url: String,
}

#[tauri::command]
pub async fn sync_status(state: State<'_, SyncState>) -> Result<SyncStatus, CommandError> {
    state.status().await
}

#[tauri::command]
pub async fn sync_backup_now(state: State<'_, SyncState>) -> Result<BackupNowResult, CommandError> {
    let owned = state.inner().clone();
    let version = tokio::task::spawn_blocking(move || owned.create_version(ORIGIN_MANUAL))
        .await
        .map_err(join_error)??;
    if version.is_some() {
        state.request_push();
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
pub async fn sync_versions(state: State<'_, SyncState>) -> Result<Vec<SyncVersion>, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_versions())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_restore_version(
    state: State<'_, SyncState>,
    id: String,
) -> Result<RestoreResult, CommandError> {
    let owned = state.inner().clone();
    let version = tokio::task::spawn_blocking(move || owned.restore_version(&id))
        .await
        .map_err(join_error)??;
    state.request_push();
    Ok(RestoreResult {
        restored: true,
        version,
    })
}

#[tauri::command]
pub async fn sync_delete_version(
    state: State<'_, SyncState>,
    id: String,
    force: bool,
) -> Result<(), CommandError> {
    state.delete_version_with_cloud(&id, force).await
}

#[tauri::command]
pub async fn sync_events(
    state: State<'_, SyncState>,
    limit: Option<i64>,
) -> Result<Vec<SyncEvent>, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_events(limit.unwrap_or(50)))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_get_settings(state: State<'_, SyncState>) -> Result<SyncSettings, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.get_settings())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_update_settings(
    state: State<'_, SyncState>,
    mut settings: SyncSettings,
    sync_password: Option<String>,
) -> Result<SavedResult, CommandError> {
    settings.sync_password = sync_password.unwrap_or_default();
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.save_settings(settings))
        .await
        .map_err(join_error)??;
    state.reload_scheduler();
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub async fn sync_reveal_password(
    state: State<'_, SyncState>,
) -> Result<PasswordResult, CommandError> {
    let owned = state.inner().clone();
    let sync_password = tokio::task::spawn_blocking(move || owned.reveal_password())
        .await
        .map_err(join_error)??;
    Ok(PasswordResult { sync_password })
}

#[tauri::command]
pub async fn sync_shutdown(state: State<'_, SyncState>) -> Result<(), CommandError> {
    state.shutdown_backup().await;
    Ok(())
}

#[tauri::command]
pub async fn sync_now(state: State<'_, SyncState>) -> Result<StartedResult, CommandError> {
    state.request_sync();
    Ok(StartedResult { started: true })
}

#[tauri::command]
pub async fn sync_push(state: State<'_, SyncState>) -> Result<StartedResult, CommandError> {
    state.request_push();
    Ok(StartedResult { started: true })
}

#[tauri::command]
pub async fn sync_resolve_conflict(
    state: State<'_, SyncState>,
    choice: String,
) -> Result<ResolvedResult, CommandError> {
    let version = state.resolve_conflict(&choice).await?;
    Ok(ResolvedResult {
        resolved: true,
        version,
    })
}

#[tauri::command]
pub async fn sync_providers(
    state: State<'_, SyncState>,
) -> Result<Vec<SyncProviderMeta>, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.list_providers())
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_create_provider(
    state: State<'_, SyncState>,
    config: SyncProviderConfig,
) -> Result<SyncProviderMeta, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.create_provider(config))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_update_provider(
    state: State<'_, SyncState>,
    id: String,
    config: SyncProviderConfig,
) -> Result<SavedResult, CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.update_provider(&id, config))
        .await
        .map_err(join_error)??;
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub async fn sync_delete_provider(
    state: State<'_, SyncState>,
    id: String,
) -> Result<(), CommandError> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || owned.delete_provider(&id))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn sync_test_provider(
    state: State<'_, SyncState>,
    id: String,
) -> Result<SavedResult, CommandError> {
    state.test_provider(&id).await?;
    Ok(SavedResult { saved: true })
}

#[tauri::command]
pub async fn sync_oauth_url(
    state: State<'_, SyncState>,
    provider_type: String,
    provider_id: String,
) -> Result<OAuthURLResult, CommandError> {
    let url = state.build_oauth_url(&provider_type, &provider_id)?;
    Ok(OAuthURLResult { url })
}

fn join_error(error: tokio::task::JoinError) -> CommandError {
    CommandError::new("SYNC_FAILED", format!("后台任务异常结束: {error}"))
}
