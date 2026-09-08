//! SQLite 连接工厂。
//!
//! 每个阻塞任务
//! 独占一个连接，避免把 `rusqlite::Connection` 放进全局 Mutex；迁移完成后这里
//! 会扩展为所有 Rust repository 共用的数据库入口。

use std::{path::PathBuf, sync::Arc, time::Duration};

use rusqlite::Connection;

use crate::error::CommandError;

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
        let connection = database.connect()?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;\
                 CREATE TABLE IF NOT EXISTS groups (\
                    id         TEXT PRIMARY KEY,\
                    name       TEXT NOT NULL,\
                    parent_id  TEXT REFERENCES groups(id) ON DELETE SET NULL,\
                    icon       TEXT DEFAULT 'folder',\
                    sort_order INTEGER DEFAULT 0,\
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE TABLE IF NOT EXISTS profiles (\
                    id           TEXT PRIMARY KEY,\
                    name         TEXT NOT NULL,\
                    host         TEXT NOT NULL,\
                    port         INTEGER NOT NULL DEFAULT 22,\
                    username     TEXT NOT NULL DEFAULT 'root',\
                    auth_type    TEXT NOT NULL DEFAULT 'password',\
                    vault_id     TEXT DEFAULT '',\
                    group_id     TEXT DEFAULT '',\
                    tags         TEXT DEFAULT '[]',\
                    options      TEXT DEFAULT '{}',\
                    note         TEXT DEFAULT '',\
                    sort_order   INTEGER DEFAULT 0,\
                    last_used_at DATETIME,\
                    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,\
                    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);\
                 CREATE TABLE IF NOT EXISTS vault (\
                    id          TEXT PRIMARY KEY,\
                    type        TEXT NOT NULL,\
                    data        TEXT NOT NULL,\
                    fingerprint TEXT DEFAULT '',\
                    name        TEXT NOT NULL DEFAULT '',\
                    username    TEXT DEFAULT '',\
                    remark      TEXT DEFAULT '',\
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,\
                    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE TABLE IF NOT EXISTS audit_logs (\
                    id         TEXT PRIMARY KEY,\
                    profile_id TEXT DEFAULT '',\
                    action     TEXT NOT NULL,\
                    detail     TEXT DEFAULT '',\
                    timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_logs(profile_id);\
                 CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp);\
                 CREATE TABLE IF NOT EXISTS snippets (\
                    id          TEXT PRIMARY KEY,\
                    name        TEXT NOT NULL,\
                    content     TEXT NOT NULL,\
                    description TEXT DEFAULT '',\
                    tags        TEXT DEFAULT '[]',\
                    is_global   INTEGER DEFAULT 1,\
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,\
                    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE TABLE IF NOT EXISTS sync_versions (\
                    id         TEXT PRIMARY KEY,\
                    version    INTEGER NOT NULL UNIQUE,\
                    hash       TEXT NOT NULL,\
                    size       INTEGER NOT NULL,\
                    file_path  TEXT NOT NULL,\
                    origin     TEXT NOT NULL,\
                    synced_to  TEXT NOT NULL DEFAULT '[]',\
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE INDEX IF NOT EXISTS idx_sync_versions_ver \
                    ON sync_versions(version DESC);\
                 CREATE TABLE IF NOT EXISTS sync_providers (\
                    id         TEXT PRIMARY KEY,\
                    type       TEXT NOT NULL,\
                    name       TEXT NOT NULL,\
                    enabled    INTEGER NOT NULL DEFAULT 1,\
                    config     TEXT NOT NULL,\
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE TABLE IF NOT EXISTS sync_state (\
                    id            INTEGER PRIMARY KEY CHECK (id = 1),\
                    next_version  INTEGER NOT NULL DEFAULT 1,\
                    last_sync_at  DATETIME,\
                    status        TEXT NOT NULL DEFAULT 'idle',\
                    conflict_json TEXT NOT NULL DEFAULT ''\
                );\
                 CREATE TABLE IF NOT EXISTS sync_settings (\
                    key   TEXT PRIMARY KEY,\
                    value TEXT NOT NULL\
                );\
                 CREATE TABLE IF NOT EXISTS sync_events (\
                    id          TEXT PRIMARY KEY,\
                    provider_id TEXT NOT NULL DEFAULT '',\
                    action      TEXT NOT NULL,\
                    version     INTEGER NOT NULL DEFAULT 0,\
                    success     INTEGER NOT NULL,\
                    error       TEXT NOT NULL DEFAULT '',\
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP\
                );\
                 CREATE INDEX IF NOT EXISTS idx_sync_events_time \
                    ON sync_events(created_at DESC);\
                 INSERT OR IGNORE INTO sync_state (id,next_version,status) \
                    VALUES (1,1,'idle');",
            )
            .map_err(CommandError::database)?;
        // A pre-metadata XControl database may be opened on mobile where no Go
        // Keep the historical additive migration idempotent across upgrades.
        add_column_if_missing(&connection, "vault", "name", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(&connection, "vault", "remark", "TEXT DEFAULT ''")?;
        add_column_if_missing(&connection, "vault", "updated_at", "DATETIME")?;
        add_column_if_missing(&connection, "vault", "username", "TEXT DEFAULT ''")?;
        add_column_if_missing(&connection, "profiles", "icon", "TEXT DEFAULT ''")?;
        add_column_if_missing(
            &connection,
            "profiles",
            "inline_credential",
            "TEXT DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "profiles",
            "proxy_credential",
            "TEXT DEFAULT ''",
        )?;
        connection
            .execute(
                "UPDATE vault SET updated_at=created_at WHERE updated_at IS NULL",
                [],
            )
            .map_err(CommandError::database)?;
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

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), CommandError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(CommandError::database)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(CommandError::database)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(CommandError::database)?;
    drop(statement);
    if !columns.iter().any(|existing| existing == column) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(CommandError::database)?;
    }
    Ok(())
}
