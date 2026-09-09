//! Typed failures for profile validation, credentials and proxy references.

#[derive(Debug, thiserror::Error)]
pub(super) enum ProfileError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Credential(String),
    #[error("{0}")]
    Reference(String),
}

impl From<String> for ProfileError {
    fn from(message: String) -> Self {
        Self::Validation(message)
    }
}

impl From<&str> for ProfileError {
    fn from(message: &str) -> Self {
        Self::Validation(message.to_owned())
    }
}
