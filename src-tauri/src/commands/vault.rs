use tauri::State;

use crate::{
    error::CommandError,
    sync::SyncState,
    vault::{
        generate_key_pair, Credential, GenerateKeyRequest, GenerateKeyResponse, ProfileRef,
        VaultItem, VaultService, VaultWriteRequest,
    },
};

#[tauri::command]
pub(crate) async fn vault_list(
    state: State<'_, VaultService>,
    vault_type: Option<String>,
    q: Option<String>,
) -> Result<Vec<VaultItem>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list(vault_type.as_deref(), q.as_deref()))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn vault_get(
    state: State<'_, VaultService>,
    id: String,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.get(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn vault_create(
    state: State<'_, VaultService>,
    sync: State<'_, SyncState>,
    request: VaultWriteRequest,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    let item = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(item)
}

#[tauri::command]
pub(crate) async fn vault_update(
    state: State<'_, VaultService>,
    sync: State<'_, SyncState>,
    id: String,
    request: VaultWriteRequest,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    let item = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(item)
}

#[tauri::command]
pub(crate) async fn vault_delete(
    state: State<'_, VaultService>,
    sync: State<'_, SyncState>,
    id: String,
) -> Result<(), CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.delete(&id))
        .await
        .map_err(CommandError::database)??;
    sync.notify_change();
    Ok(())
}

#[tauri::command]
pub(crate) async fn vault_references(
    state: State<'_, VaultService>,
    id: String,
) -> Result<Vec<ProfileRef>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.references(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn vault_reveal(
    state: State<'_, VaultService>,
    id: String,
) -> Result<Credential, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.reveal(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub(crate) async fn vault_generate_key_pair(
    request: GenerateKeyRequest,
) -> Result<GenerateKeyResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || generate_key_pair(request))
        .await
        .map_err(CommandError::database)?
}
