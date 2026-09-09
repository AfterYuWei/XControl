//! SQLite connection and migration infrastructure.

mod connection;
mod error;
mod migration;

pub(crate) use connection::Database;
pub(crate) use error::StorageError;
