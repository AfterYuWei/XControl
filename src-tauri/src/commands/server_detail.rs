//! Tauri IPC adapters for server information gathered over an SFTP-owned SSH route.

use tauri::State;

use crate::{
    error::CommandError,
    server_detail::{self, ServerInfo, ServerMetrics},
    sftp::SftpService,
};

#[tauri::command]
pub(crate) async fn server_get_info(
    service: State<'_, SftpService>,
    session_id: String,
) -> Result<ServerInfo, CommandError> {
    server_detail::get_info(service.inner(), session_id).await
}

#[tauri::command]
pub(crate) async fn server_get_metrics(
    service: State<'_, SftpService>,
    session_id: String,
) -> Result<ServerMetrics, CommandError> {
    server_detail::get_metrics(service.inner(), session_id).await
}
