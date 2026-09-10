//! Tauri IPC adapters for SSH profile tests and terminal sessions.

use serde_json::Value;
use tauri::State;

use crate::{
    error::CommandError,
    profile::{ProfileCreateRequest, ProfileService, ProfileUpdateRequest},
    ssh::{
        self, ClientMessage, ProfileTestResult, SessionCreateRequest, SessionCreateResponse,
        SessionInfo, SshService,
    },
};

#[tauri::command]
pub(crate) async fn profile_test_new(
    profiles: State<'_, ProfileService>,
    request: ProfileCreateRequest,
) -> Result<ProfileTestResult, CommandError> {
    ssh::test_new_profile(profiles.inner(), request).await
}

#[tauri::command]
pub(crate) async fn profile_test_existing(
    profiles: State<'_, ProfileService>,
    id: String,
    request: ProfileUpdateRequest,
) -> Result<ProfileTestResult, CommandError> {
    ssh::test_existing_profile(profiles.inner(), id, request).await
}

#[tauri::command]
pub(crate) async fn profile_confirm_host_key(
    profiles: State<'_, ProfileService>,
    id: String,
    fingerprint: String,
) -> Result<Value, CommandError> {
    ssh::confirm_profile_host_key(profiles.inner(), id, fingerprint).await
}

#[tauri::command]
pub(crate) async fn session_create(
    service: State<'_, SshService>,
    request: SessionCreateRequest,
) -> Result<SessionCreateResponse, CommandError> {
    service.create(request).await
}

#[tauri::command]
pub(crate) async fn session_list(
    service: State<'_, SshService>,
) -> Result<Vec<SessionInfo>, CommandError> {
    service.list().await
}

#[tauri::command]
pub(crate) async fn session_attach(
    service: State<'_, SshService>,
    id: String,
) -> Result<Vec<ClientMessage>, CommandError> {
    service.attach(&id).await
}

#[tauri::command]
pub(crate) async fn session_reconnect(
    service: State<'_, SshService>,
    id: String,
) -> Result<SessionCreateResponse, CommandError> {
    service.reconnect(&id).await
}

#[tauri::command]
pub(crate) async fn session_confirm_host_key(
    service: State<'_, SshService>,
    id: String,
    fingerprint: Option<String>,
) -> Result<Value, CommandError> {
    service.confirm_host_key(&id, fingerprint).await
}

#[tauri::command]
pub(crate) async fn host_key_decide(
    service: State<'_, SshService>,
    request_id: String,
    fingerprint: String,
    decision: String,
) -> Result<Value, CommandError> {
    service
        .decide_host_key(&request_id, fingerprint, &decision)
        .await
}

#[tauri::command]
pub(crate) async fn session_input(
    service: State<'_, SshService>,
    id: String,
    data: String,
) -> Result<(), CommandError> {
    service.input(&id, data).await
}

#[tauri::command]
pub(crate) async fn session_resize(
    service: State<'_, SshService>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), CommandError> {
    service.resize(&id, cols, rows).await
}

#[tauri::command]
pub(crate) async fn session_ping(
    service: State<'_, SshService>,
    id: String,
) -> Result<(), CommandError> {
    service.ping(&id).await
}

#[tauri::command]
pub(crate) async fn session_auth_respond(
    service: State<'_, SshService>,
    request_id: String,
    responses: Vec<String>,
) -> Result<(), CommandError> {
    service.respond_auth(&request_id, responses).await
}

#[tauri::command]
pub(crate) async fn session_complete(
    service: State<'_, SshService>,
    id: String,
    request_id: String,
    script: String,
    cwd: Option<String>,
) -> Result<(), CommandError> {
    service.complete(&id, request_id, script, cwd).await
}

#[tauri::command]
pub(crate) async fn session_close(
    service: State<'_, SshService>,
    id: String,
) -> Result<(), CommandError> {
    service.close(&id).await
}
