use tauri::State;

use crate::{
    audit::{AuditLog, AuditRepository},
    error::CommandError,
};

#[tauri::command]
pub(crate) async fn audit_list(
    repository: State<'_, AuditRepository>,
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditLog>, CommandError> {
    let repository = repository.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.list(profile_id.as_deref(), limit.unwrap_or(100))
    })
    .await
    .map_err(CommandError::database)?
}
