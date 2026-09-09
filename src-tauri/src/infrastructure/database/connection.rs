//! SQLite connection factory.

use std::{path::PathBuf, sync::Arc, time::Duration};

use rusqlite::Connection;

use crate::{error::CommandError, infrastructure::database::migration};

#[derive(Clone)]
pub struct Database {
    path: Arc<PathBuf>,
}

impl Database {
    pub fn initialize(path: PathBuf) -> Result<Self, CommandError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(CommandError::database)?;
        }
        let database = Self {
            path: Arc::new(path),
        };
        migration::migrate(&database.connect()?)?;
        Ok(database)
    }

    pub fn connect(&self) -> Result<Connection, CommandError> {
        let connection = Connection::open(self.path.as_ref()).map_err(CommandError::database)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(CommandError::database)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(CommandError::database)?;
        Ok(connection)
    }
}
