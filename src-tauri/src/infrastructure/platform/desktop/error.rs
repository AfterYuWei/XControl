//! Typed failures produced by desktop platform adapters.

#[derive(Debug, thiserror::Error)]
pub(crate) enum PlatformError {
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("{action}: {source}")]
    Io {
        action: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("{0}")]
    Dialog(String),
    #[error("{0}")]
    Preparation(String),
}

impl PlatformError {
    pub(super) fn io(action: &'static str, source: std::io::Error) -> Self {
        Self::Io { action, source }
    }
}
