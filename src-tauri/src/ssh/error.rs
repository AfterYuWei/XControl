//! Typed SSH transport and protocol failures.

#[derive(Debug, thiserror::Error)]
pub(crate) enum SshError {
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Protocol(String),
    #[error("{0}")]
    Authentication(String),
}

impl From<String> for SshError {
    fn from(message: String) -> Self {
        Self::Transport(message)
    }
}

impl From<&str> for SshError {
    fn from(message: &str) -> Self {
        Self::Transport(message.to_owned())
    }
}

impl From<russh::Error> for SshError {
    fn from(error: russh::Error) -> Self {
        Self::Protocol(error.to_string())
    }
}
