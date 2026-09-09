//! Outbound event port for SFTP session and transfer notifications.

pub(crate) trait SftpEventSink: Send + Sync {
    fn emit_sftp(&self, event_type: &'static str, payload: serde_json::Value);
}
