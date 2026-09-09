use tauri::State;

use crate::{
    error::CommandError,
    profile::{Profile, ProfileCreateRequest, ProfileService, ProfileUpdateRequest},
    sync::SyncService,
};

#[tauri::command]
pub(crate) async fn profile_list(
    state: State<'_, ProfileService>,
    group_id: Option<String>,
    search: Option<String>,
) -> Result<Vec<Profile>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list(group_id.as_deref(), search.as_deref()))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn profile_get(
    state: State<'_, ProfileService>,
    id: String,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.get(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn profile_create(
    state: State<'_, ProfileService>,
    sync: State<'_, SyncService>,
    request: ProfileCreateRequest,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    let profile = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn profile_update(
    state: State<'_, ProfileService>,
    sync: State<'_, SyncService>,
    id: String,
    request: ProfileUpdateRequest,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    let profile = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn profile_delete(
    state: State<'_, ProfileService>,
    sync: State<'_, SyncService>,
    id: String,
) -> Result<(), CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.delete(&id))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(())
}
