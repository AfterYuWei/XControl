//! Typed failures below the backup use-case boundary.

#[derive(Debug, thiserror::Error)]
pub(super) enum BackupError {
    #[error("{0}")]
    Kdf(String),
    #[error("encrypt failed")]
    Encrypt,
    #[error("decrypt failed")]
    Decrypt,
    #[error("{0}")]
    InvalidCiphertext(String),
    #[error("{0}")]
    InvalidGraph(String),
    #[error("{0}")]
    Repository(String),
    #[error(transparent)]
    Vault(#[from] crate::vault::VaultError),
}
