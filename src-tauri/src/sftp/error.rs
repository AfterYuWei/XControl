//! Typed failures inside the SFTP feature.

#[derive(Debug, thiserror::Error)]
pub(crate) enum SftpError {
    #[error("{0}")]
    Backend(String),
    #[error("{0}")]
    Transfer(String),
    #[error("{0}")]
    Archive(String),
}

impl SftpError {
    pub(super) fn transfer(message: impl Into<String>) -> Self {
        Self::Transfer(message.into())
    }

    pub(super) fn archive(message: impl Into<String>) -> Self {
        Self::Archive(message.into())
    }
}

impl From<String> for SftpError {
    fn from(message: String) -> Self {
        Self::Backend(message)
    }
}

impl From<&str> for SftpError {
    fn from(message: &str) -> Self {
        Self::Backend(message.to_owned())
    }
}
