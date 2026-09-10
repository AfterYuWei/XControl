//! Tauri IPC adapters for SFTP sessions, file operations and transfers.

use tauri::{ipc::InvokeBody, State};

use crate::{error::CommandError, sftp};

#[tauri::command]
pub(crate) async fn sftp_create_session(
    service: State<'_, sftp::SftpService>,
    profile_id: String,
) -> Result<sftp::SftpCreateSessionResponse, CommandError> {
    sftp::create_session(service.inner(), profile_id).await
}

#[tauri::command]
pub(crate) async fn sftp_get_session(
    service: State<'_, sftp::SftpService>,
    id: String,
) -> Result<sftp::SftpSessionInfo, CommandError> {
    sftp::get_session(service.inner(), id).await
}

#[tauri::command]
pub(crate) async fn sftp_reconnect_session(
    service: State<'_, sftp::SftpService>,
    id: String,
) -> Result<sftp::SftpCreateSessionResponse, CommandError> {
    service.reconnect(&id).await
}

#[tauri::command]
pub(crate) async fn sftp_host_key_decide(
    service: State<'_, sftp::SftpService>,
    request_id: String,
    fingerprint: String,
    decision: String,
) -> Result<serde_json::Value, CommandError> {
    service
        .decide_host_key(&request_id, fingerprint, &decision)
        .await
}

#[tauri::command]
pub(crate) async fn sftp_list_sessions(
    service: State<'_, sftp::SftpService>,
) -> Result<Vec<sftp::SftpSessionInfo>, CommandError> {
    sftp::list_sessions(service.inner()).await
}

#[tauri::command]
pub(crate) async fn sftp_close_session(
    service: State<'_, sftp::SftpService>,
    id: String,
) -> Result<(), CommandError> {
    sftp::close_session(service.inner(), id).await
}

#[tauri::command]
pub(crate) async fn sftp_list(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
    show_hidden: Option<bool>,
) -> Result<sftp::SftpListResponse, CommandError> {
    sftp::list(service.inner(), session_id, path, show_hidden).await
}

#[tauri::command]
pub(crate) async fn sftp_stat(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
) -> Result<sftp::SftpEntry, CommandError> {
    sftp::stat(service.inner(), session_id, path).await
}

#[tauri::command]
pub(crate) async fn sftp_tree(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
    depth: Option<u32>,
) -> Result<sftp::SftpTreeResponse, CommandError> {
    sftp::tree_entries(service.inner(), session_id, path, depth).await
}

#[tauri::command]
pub(crate) async fn sftp_mkdir(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
) -> Result<sftp::SftpEntry, CommandError> {
    sftp::mkdir(service.inner(), session_id, path).await
}

#[tauri::command]
pub(crate) async fn sftp_rename(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<sftp::SftpEntry, CommandError> {
    sftp::rename(service.inner(), session_id, old_path, new_path).await
}

#[tauri::command]
pub(crate) async fn sftp_delete(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    paths: Vec<String>,
) -> Result<sftp::SftpDeleteResponse, CommandError> {
    sftp::delete(service.inner(), session_id, paths).await
}

#[tauri::command]
pub(crate) async fn sftp_read_file(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
) -> Result<sftp::SftpFileReadResponse, CommandError> {
    sftp::read_file(service.inner(), session_id, path).await
}

#[tauri::command]
pub(crate) async fn sftp_write_file(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    path: String,
    request: sftp::SftpFileWriteRequest,
) -> Result<sftp::SftpFileWriteResponse, CommandError> {
    sftp::write_file(service.inner(), session_id, path, request).await
}

#[tauri::command]
pub(crate) async fn sftp_upload_begin(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    name: String,
    dest_dir: String,
    overwrite: bool,
    size: u64,
) -> Result<sftp::SftpUploadBeginResponse, CommandError> {
    sftp::sftp_upload_begin(service.inner(), session_id, name, dest_dir, overwrite, size).await
}

#[tauri::command]
pub(crate) async fn sftp_upload_chunk(
    service: State<'_, sftp::SftpService>,
    request: tauri::ipc::Request<'_>,
) -> Result<sftp::SftpUploadChunkResponse, CommandError> {
    let upload_id = request
        .headers()
        .get("x-eizhu-upload-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| CommandError::new("VALIDATION", "upload id is required"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "INVALID_FORM",
            "raw upload chunk is required",
        ));
    };
    sftp::upload_chunk(service.inner(), upload_id, bytes).await
}

#[tauri::command]
pub(crate) async fn sftp_upload_chunk_base64(
    service: State<'_, sftp::SftpService>,
    upload_id: String,
    data: String,
) -> Result<sftp::SftpUploadChunkResponse, CommandError> {
    sftp::sftp_upload_chunk_base64(service.inner(), upload_id, data).await
}

#[tauri::command]
pub(crate) async fn sftp_upload_finish(
    service: State<'_, sftp::SftpService>,
    upload_id: String,
) -> Result<sftp::SftpUploadResponse, CommandError> {
    sftp::sftp_upload_finish(service.inner(), upload_id).await
}

#[tauri::command]
pub(crate) async fn sftp_upload_abort(
    service: State<'_, sftp::SftpService>,
    upload_id: String,
) -> Result<(), CommandError> {
    sftp::sftp_upload_abort(service.inner(), upload_id).await
}

#[tauri::command]
pub(crate) async fn sftp_download(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    paths: Vec<String>,
) -> Result<sftp::SftpDownloadResponse, CommandError> {
    sftp::sftp_download(service.inner(), session_id, paths).await
}

#[tauri::command]
pub(crate) async fn sftp_download_chunk(
    service: State<'_, sftp::SftpService>,
    task_id: String,
    offset: u64,
    max_bytes: u32,
) -> Result<tauri::ipc::Response, CommandError> {
    let bytes = sftp::sftp_download_chunk(service.inner(), task_id, offset, max_bytes).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn sftp_download_chunk_base64(
    service: State<'_, sftp::SftpService>,
    task_id: String,
    offset: u64,
    max_bytes: u32,
) -> Result<String, CommandError> {
    sftp::sftp_download_chunk_base64(service.inner(), task_id, offset, max_bytes).await
}

#[tauri::command]
pub(crate) async fn sftp_download_close(
    service: State<'_, sftp::SftpService>,
    task_id: String,
) -> Result<(), CommandError> {
    sftp::sftp_download_close(service.inner(), task_id).await
}

#[tauri::command]
pub(crate) async fn sftp_list_transfers(
    service: State<'_, sftp::SftpService>,
    session_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<sftp::TransferTask>, CommandError> {
    sftp::sftp_list_transfers(service.inner(), session_id, status).await
}

#[tauri::command]
pub(crate) async fn sftp_cancel_transfer(
    service: State<'_, sftp::SftpService>,
    task_id: String,
) -> Result<serde_json::Value, CommandError> {
    sftp::sftp_cancel_transfer(service.inner(), task_id).await
}

#[tauri::command]
pub(crate) async fn sftp_clear_completed_transfers(
    service: State<'_, sftp::SftpService>,
) -> Result<(), CommandError> {
    sftp::sftp_clear_completed_transfers(service.inner()).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_transfer(
    service: State<'_, sftp::SftpService>,
    source_session_id: String,
    target_session_id: String,
    paths: Vec<String>,
    dest_dir: String,
    conflict_resolution: Option<String>,
    directory_mode: Option<String>,
) -> Result<sftp::SftpTransferResponse, CommandError> {
    sftp::sftp_transfer(
        service.inner(),
        source_session_id,
        target_session_id,
        paths,
        dest_dir,
        conflict_resolution,
        directory_mode,
    )
    .await
}

#[tauri::command]
pub(crate) async fn sftp_move(
    service: State<'_, sftp::SftpService>,
    session_id: String,
    paths: Vec<String>,
    dest_dir: String,
    conflict_resolution: Option<String>,
) -> Result<sftp::SftpMoveResponse, CommandError> {
    sftp::sftp_move(
        service.inner(),
        session_id,
        paths,
        dest_dir,
        conflict_resolution,
    )
    .await
}
