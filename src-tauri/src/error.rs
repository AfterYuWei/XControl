//! Tauri 领域命令共享的结构化错误。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<serde_json::Value>,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            references: None,
        }
    }

    pub fn with_references(mut self, references: impl Serialize) -> Self {
        self.references = serde_json::to_value(references).ok();
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
