use tauri::State;

use crate::{
    error::CommandError,
    snippet::{Snippet, SnippetCreateRequest, SnippetService, SnippetUpdateRequest},
    sync::SyncService,
};

#[tauri::command]
pub(crate) async fn snippet_list(
    service: State<'_, SnippetService>,
) -> Result<Vec<Snippet>, CommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn snippet_create(
    service: State<'_, SnippetService>,
    sync: State<'_, SyncService>,
    request: SnippetCreateRequest,
) -> Result<Snippet, CommandError> {
    let service = service.inner().clone();
    let snippet = tauri::async_runtime::spawn_blocking(move || service.create(request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(snippet)
}

#[tauri::command]
pub(crate) async fn snippet_update(
    service: State<'_, SnippetService>,
    sync: State<'_, SyncService>,
    id: String,
    request: SnippetUpdateRequest,
) -> Result<Snippet, CommandError> {
    let service = service.inner().clone();
    let snippet = tauri::async_runtime::spawn_blocking(move || service.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(snippet)
}

#[tauri::command]
pub(crate) async fn snippet_delete(
    service: State<'_, SnippetService>,
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
