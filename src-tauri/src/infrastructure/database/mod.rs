//! SQLite connection and migration infrastructure.

mod connection;
mod migration;

pub(crate) use connection::Database;
