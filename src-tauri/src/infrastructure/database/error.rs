//! Typed failures owned by the SQLite infrastructure boundary.

#[derive(Debug, thiserror::Error)]
pub(crate) enum StorageError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
