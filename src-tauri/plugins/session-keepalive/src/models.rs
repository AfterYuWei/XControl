use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveRequest {
    pub active_sessions: usize,
    pub duration_seconds: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveResponse {
    pub started: bool,
    pub notification_permission: bool,
}
