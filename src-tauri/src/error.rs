//! Tauri 领域命令共享的结构化错误。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Box<serde_json::Value>>,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
            session_id: None,
            stage: None,
            references: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: impl Serialize) -> Self {
        self.details = serde_json::to_value(details).ok().map(Box::new);
        self
    }

    pub fn with_session(mut self, session_id: impl Into<String>, stage: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into().into_boxed_str());
        self.stage = Some(stage.into().into_boxed_str());
        self
    }

    pub fn with_references(mut self, references: impl Serialize) -> Self {
        self.references = serde_json::to_value(references).ok().map(Box::new);
        self
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        Self::new("DB_ERROR", error.to_string())
    }
}

impl From<crate::infrastructure::database::StorageError> for CommandError {
    fn from(error: crate::infrastructure::database::StorageError) -> Self {
        Self::database(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_error_carries_mobile_recovery_context() {
        let error = CommandError::new("BACKGROUND_LIMIT", "window expired")
            .retryable()
            .with_session("session-1", "background")
            .with_details(serde_json::json!({"remaining_seconds": 0}));
        let value = serde_json::to_value(error).expect("serialize");
        assert_eq!(value["code"], "BACKGROUND_LIMIT");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["session_id"], "session-1");
        assert_eq!(value["stage"], "background");
    }
}
