//! Tauri implementation of outbound feature event ports.

use tauri::{AppHandle, Emitter};

use crate::{sftp::SftpEventSink, ssh::SessionEventSink};

#[derive(Clone)]
pub(crate) struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl SessionEventSink for TauriEventSink {
    fn emit_session(&self, payload: serde_json::Value) {
        let _ = self.app.emit("eizhu-session-message", payload);
    }
}

impl SftpEventSink for TauriEventSink {
    fn emit_sftp(&self, event_type: &'static str, payload: serde_json::Value) {
        let _ = self.app.emit(
            "eizhu-sftp-message",
            serde_json::json!({"type": event_type, "payload": payload}),
        );
    }
}
