//! SQLite connection factory.

use std::{path::PathBuf, sync::Arc, time::Duration};

use rusqlite::Connection;

use crate::infrastructure::database::{migration, StorageError};

#[derive(Clone)]
pub struct Database {
    path: Arc<PathBuf>,
}

impl Database {
    pub fn initialize(path: PathBuf) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let database = Self {
            path: Arc::new(path),
        };
        migration::migrate(&database.connect()?)?;
        Ok(database)
    }

    pub fn connect(&self) -> Result<Connection, StorageError> {
        let connection = Connection::open(self.path.as_ref())?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(connection)
    }
}
