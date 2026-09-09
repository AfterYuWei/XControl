//! 审计日志领域。
//!
//! Rust 领域通过 `AuditState::record` 写入；查询通过细粒度 Tauri command 暴露。
//! 日志不属于可同步业务数据，因此写入不触发 change notifier。

use chrono::{Local, SecondsFormat};
use rusqlite::{params, Row};
use serde::Serialize;
use tauri::State;

use crate::{error::CommandError, infrastructure::database::Database};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditLog {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    pub timestamp: String,
}

#[derive(Clone)]
pub struct AuditState {
    database: Database,
}

impl AuditState {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    /// Best-effort 与否由调用领域决定；repository 自身始终返回实际写入错误。
    #[allow(dead_code)]
    pub fn record(
        &self,
        profile_id: impl Into<String>,
        action: impl Into<String>,
        detail: impl Into<String>,
    ) -> Result<AuditLog, CommandError> {
        let log = AuditLog {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.into(),
            action: action.into(),
            detail: detail.into(),
            timestamp: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
        };
        self.insert(&log)?;
        Ok(log)
    }

    fn insert(&self, log: &AuditLog) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        connection
            .execute(
                "INSERT INTO audit_logs (id, profile_id, action, detail, timestamp) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    log.id,
                    log.profile_id,
                    log.action,
                    log.detail,
                    log.timestamp,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    fn list(&self, profile_id: Option<&str>, limit: i64) -> Result<Vec<AuditLog>, CommandError> {
        let connection = self.database.connect()?;
        let effective_limit = if limit <= 0 { 100 } else { limit };
        let (query, filter) = match profile_id.filter(|id| !id.is_empty()) {
            Some(id) => (
                "SELECT id, profile_id, action, detail, timestamp FROM audit_logs \
                 WHERE profile_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
                Some(id),
            ),
            None => (
                "SELECT id, profile_id, action, detail, timestamp FROM audit_logs \
                 ORDER BY timestamp DESC LIMIT ?1",
                None,
            ),
        };
        let mut statement = connection.prepare(query).map_err(CommandError::database)?;
        let rows = match filter {
            Some(id) => statement
                .query_map(params![id, effective_limit], audit_from_row)
                .map_err(CommandError::database)?,
            None => statement
                .query_map([effective_limit], audit_from_row)
                .map_err(CommandError::database)?,
        };
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }
}

fn audit_from_row(row: &Row<'_>) -> rusqlite::Result<AuditLog> {
    Ok(AuditLog {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        action: row.get(2)?,
        detail: row.get(3)?,
        timestamp: row.get(4)?,
    })
}

#[tauri::command]
pub async fn audit_list(
    state: State<'_, AuditState>,
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditLog>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.list(profile_id.as_deref(), limit.unwrap_or(100))
    })
    .await
    .map_err(CommandError::database)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, AuditState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let state = AuditState::new(database);
        (directory, state)
    }

    #[test]
    fn record_and_list_support_filter_and_default_limit() {
        let (_directory, state) = state();
        let first = AuditLog {
            id: "a1".into(),
            profile_id: "p1".into(),
            action: "connect".into(),
            detail: String::new(),
            timestamp: "2026-09-07T10:00:00Z".into(),
        };
        let second = AuditLog {
            id: "a2".into(),
            profile_id: "p2".into(),
            action: "sftp_upload".into(),
            detail: "file=/tmp/a".into(),
            timestamp: "2026-09-07T11:00:00Z".into(),
        };
        state.insert(&first).unwrap();
        state.insert(&second).unwrap();

        assert_eq!(state.list(None, 0).unwrap(), vec![second, first.clone()]);
        assert_eq!(state.list(Some("p1"), 10).unwrap(), vec![first]);
        assert!(state.list(Some("missing"), 10).unwrap().is_empty());
    }

    #[test]
    fn positive_limit_is_respected() {
        let (_directory, state) = state();
        for index in 0..3 {
            state
                .insert(&AuditLog {
                    id: format!("a{index}"),
                    profile_id: String::new(),
                    action: "backup_import".into(),
                    detail: String::new(),
                    timestamp: format!("2026-09-07T10:00:0{index}Z"),
                })
                .unwrap();
        }
        let logs = state.list(None, 2).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].id, "a2");
    }

    #[test]
    fn record_generates_identity_and_timestamp() {
        let (_directory, state) = state();
        let log = state.record("p1", "connect", "host=example.com").unwrap();
        assert!(uuid::Uuid::parse_str(&log.id).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&log.timestamp).is_ok());
        assert_eq!(state.list(Some("p1"), 1).unwrap(), vec![log]);
    }
}
