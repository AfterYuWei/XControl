//! Outbound event port for terminal session notifications.

pub(crate) trait SessionEventSink: Send + Sync {
    fn emit_session(&self, payload: serde_json::Value);
}
