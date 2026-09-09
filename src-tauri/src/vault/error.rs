//! Typed failures for credential encoding at the vault boundary.

#[derive(Debug, thiserror::Error)]
pub(crate) enum VaultError {
    #[error("{0}")]
    Serialize(#[from] serde_json::Error),
    #[error("unsupported vault type: {0}")]
    UnsupportedType(String),
}
