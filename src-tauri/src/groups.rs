//! 分组领域：分组 CRUD 与非空删除保护，React 通过 Tauri invoke 直接访问。

use chrono::{Local, SecondsFormat};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{database::Database, error::CommandError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub icon: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct GroupCreateRequest {
    pub name: String,
    pub parent_id: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GroupUpdateRequest {
    pub name: Option<String>,
    pub parent_id: Option<String>,
    pub icon: Option<String>,
}

#[derive(Clone)]
pub struct GroupState {
    database: Database,
}

impl GroupState {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub(crate) fn list(&self) -> Result<Vec<Group>, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, parent_id, icon, sort_order, created_at \
                 FROM groups ORDER BY sort_order, name",
            )
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], group_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    fn get(&self, id: &str) -> Result<Option<Group>, CommandError> {
        let connection = self.database.connect()?;
        connection
            .query_row(
                "SELECT id, name, parent_id, icon, sort_order, created_at \
                 FROM groups WHERE id = ?1",
                [id],
                group_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    fn create(&self, request: GroupCreateRequest) -> Result<Group, CommandError> {
        if request.name.is_empty() {
            return Err(CommandError::new("VALIDATION", "name is required"));
        }
        let parent_id = request.parent_id.filter(|id| !id.is_empty());
        let group = Group {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name,
            parent_id,
            icon: request
                .icon
                .filter(|icon| !icon.is_empty())
                .unwrap_or_else(|| "folder".into()),
            sort_order: 0,
            created_at: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
        };
        let connection = self.database.connect()?;
        connection
            .execute(
                "INSERT INTO groups (id, name, parent_id, icon, sort_order, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    group.id,
                    group.name,
                    group.parent_id,
                    group.icon,
                    group.sort_order,
                    group.created_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(group)
    }

    fn update(&self, id: &str, request: GroupUpdateRequest) -> Result<Group, CommandError> {
        let mut group = self.get(id)?.ok_or_else(|| {
            // 旧 store 在 update 前 Get；不存在时 handler 返回 DB_ERROR。
            CommandError::new("DB_ERROR", "sql: no rows in result set")
        })?;
        if let Some(name) = request.name {
            group.name = name;
        }
        if let Some(parent_id) = request.parent_id {
            group.parent_id = (!parent_id.is_empty()).then_some(parent_id);
        }
        if let Some(icon) = request.icon {
            group.icon = icon;
        }
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE groups SET name=?1, parent_id=?2, icon=?3 WHERE id=?4",
                params![group.name, group.parent_id, group.icon, id],
            )
            .map_err(CommandError::database)?;
        Ok(group)
    }

    fn delete(&self, id: &str) -> Result<(), CommandError> {
        let mut connection = self.database.connect()?;
        let transaction = connection.transaction().map_err(CommandError::database)?;
        let profile_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE group_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(CommandError::database)?;
        if profile_count > 0 {
            return Err(CommandError::new(
                "GROUP_NOT_EMPTY",
                format!("该分组下仍有 {profile_count} 台服务器，请先移动或删除后再删除分组"),
            ));
        }
        transaction
            .execute(
                "UPDATE groups SET parent_id = NULL WHERE parent_id = ?1",
                [id],
            )
            .map_err(CommandError::database)?;
        transaction
            .execute("DELETE FROM groups WHERE id = ?1", [id])
            .map_err(CommandError::database)?;
        transaction.commit().map_err(CommandError::database)
    }
}

fn group_from_row(row: &Row<'_>) -> rusqlite::Result<Group> {
    Ok(Group {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        icon: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[tauri::command]
pub async fn group_list(state: State<'_, GroupState>) -> Result<Vec<Group>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list())
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn group_create(
    state: State<'_, GroupState>,
    sync_state: State<'_, crate::sync::SyncState>,
    request: GroupCreateRequest,
) -> Result<Group, CommandError> {
    let state = state.inner().clone();
    let group = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(group)
}

#[tauri::command]
pub async fn group_update(
    state: State<'_, GroupState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
    request: GroupUpdateRequest,
) -> Result<Group, CommandError> {
    let state = state.inner().clone();
    let group = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(group)
}

#[tauri::command]
pub async fn group_delete(
    state: State<'_, GroupState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
) -> Result<(), CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.delete(&id))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, GroupState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let state = GroupState::new(database);
        (directory, state)
    }

    #[test]
    fn crud_preserves_defaults_ordering_and_child_detach() {
        let (_directory, state) = state();
        let parent = state
            .create(GroupCreateRequest {
                name: "生产".into(),
                parent_id: None,
                icon: None,
            })
            .unwrap();
        assert_eq!(parent.icon, "folder");
        assert_eq!(parent.sort_order, 0);

        let child = state
            .create(GroupCreateRequest {
                name: "子组".into(),
                parent_id: Some(parent.id.clone()),
                icon: Some("boxes".into()),
            })
            .unwrap();
        let updated = state
            .update(
                &child.id,
                GroupUpdateRequest {
                    name: Some("应用".into()),
                    parent_id: None,
                    icon: None,
                },
            )
            .unwrap();
        assert_eq!(updated.parent_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(updated.icon, "boxes");

        state.delete(&parent.id).unwrap();
        let detached = state.get(&child.id).unwrap().unwrap();
        assert_eq!(detached.parent_id, None);
        assert_eq!(state.list().unwrap(), vec![detached]);
    }

    #[test]
    fn delete_rejects_non_empty_group_with_compatible_error() {
        let (_directory, state) = state();
        let group = state
            .create(GroupCreateRequest {
                name: "生产".into(),
                parent_id: None,
                icon: None,
            })
            .unwrap();
        let connection = state.database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO profiles (id, name, host, group_id) VALUES ('p1', 'web', '10.0.0.1', ?1)",
                [&group.id],
            )
            .unwrap();

        let error = state.delete(&group.id).unwrap_err();
        assert_eq!(error.code, "GROUP_NOT_EMPTY");
        assert_eq!(
            error.message,
            "该分组下仍有 1 台服务器，请先移动或删除后再删除分组"
        );
        assert!(state.get(&group.id).unwrap().is_some());
    }

    #[test]
    fn validation_and_missing_update_match_go_contract() {
        let (_directory, state) = state();
        let error = state
            .create(GroupCreateRequest {
                name: String::new(),
                parent_id: None,
                icon: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(error.message, "name is required");

        let error = state
            .update(
                "missing",
                GroupUpdateRequest {
                    name: None,
                    parent_id: None,
                    icon: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "DB_ERROR");
        // 与旧接口一致：删除不存在的分组成功。
        state.delete("missing").unwrap();
    }
}
