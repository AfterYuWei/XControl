use tauri::State;

use crate::{
    error::CommandError,
    group::{Group, GroupCreateRequest, GroupService, GroupUpdateRequest},
    sync::SyncService,
};

#[tauri::command]
pub(crate) async fn group_list(
    service: State<'_, GroupService>,
) -> Result<Vec<Group>, CommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn group_create(
    service: State<'_, GroupService>,
    sync: State<'_, SyncService>,
    request: GroupCreateRequest,
) -> Result<Group, CommandError> {
    let service = service.inner().clone();
    let group = tauri::async_runtime::spawn_blocking(move || service.create(request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(group)
}

#[tauri::command]
pub(crate) async fn group_update(
    service: State<'_, GroupService>,
    sync: State<'_, SyncService>,
    id: String,
    request: GroupUpdateRequest,
) -> Result<Group, CommandError> {
    let service = service.inner().clone();
    let group = tauri::async_runtime::spawn_blocking(move || service.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(group)
}

#[tauri::command]
pub(crate) async fn group_delete(
    service: State<'_, GroupService>,
    sync: State<'_, SyncService>,
    id: String,
) -> Result<(), CommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.delete(&id))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(())
}
