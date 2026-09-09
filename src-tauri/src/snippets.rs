//! 命令片段领域：React 通过 Tauri invoke 直接访问。

use chrono::{Local, SecondsFormat};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{error::CommandError, infrastructure::database::Database};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub tags: Vec<String>,
    pub is_global: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SnippetCreateRequest {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub is_global: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SnippetUpdateRequest {
    pub name: Option<String>,
    pub content: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_global: Option<bool>,
}

#[derive(Clone)]
pub struct SnippetState {
    database: Database,
}

impl SnippetState {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    fn list(&self) -> Result<Vec<Snippet>, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, content, description, tags, is_global, \
                 created_at, updated_at FROM snippets ORDER BY name",
            )
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], snippet_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    fn get(&self, id: &str) -> Result<Option<Snippet>, CommandError> {
        let connection = self.database.connect()?;
        connection
            .query_row(
                "SELECT id, name, content, description, tags, is_global, \
                 created_at, updated_at FROM snippets WHERE id = ?1",
                [id],
                snippet_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    fn create(&self, request: SnippetCreateRequest) -> Result<Snippet, CommandError> {
        if request.name.is_empty() || request.content.is_empty() {
            return Err(CommandError::new(
                "VALIDATION",
                "name and content are required",
            ));
        }

        let now = Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true);
        let snippet = Snippet {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name,
            content: request.content,
            description: request.description,
            tags: request.tags,
            is_global: request.is_global.unwrap_or(true),
            created_at: now.clone(),
            updated_at: now,
        };
        let tags = serde_json::to_string(&snippet.tags).map_err(CommandError::database)?;
        let connection = self.database.connect()?;
        connection
            .execute(
                "INSERT INTO snippets \
                 (id, name, content, description, tags, is_global, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    snippet.id,
                    snippet.name,
                    snippet.content,
                    snippet.description,
                    tags,
                    snippet.is_global,
                    snippet.created_at,
                    snippet.updated_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(snippet)
    }

    fn update(&self, id: &str, request: SnippetUpdateRequest) -> Result<Snippet, CommandError> {
        let mut snippet = self.get(id)?.ok_or_else(|| {
            // Go store 先 Get 再 Update；不存在时原接口以 DB_ERROR 返回。
            CommandError::new("DB_ERROR", "sql: no rows in result set")
        })?;
        if let Some(name) = request.name {
            snippet.name = name;
        }
        if let Some(content) = request.content {
            snippet.content = content;
        }
        if let Some(description) = request.description {
            snippet.description = description;
        }
        if let Some(tags) = request.tags {
            snippet.tags = tags;
        }
        if let Some(is_global) = request.is_global {
            snippet.is_global = is_global;
        }
        snippet.updated_at = Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true);

        let tags = serde_json::to_string(&snippet.tags).map_err(CommandError::database)?;
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE snippets SET name=?1, content=?2, description=?3, tags=?4, \
                 is_global=?5, updated_at=?6 WHERE id=?7",
                params![
                    snippet.name,
                    snippet.content,
                    snippet.description,
                    tags,
                    snippet.is_global,
                    snippet.updated_at,
                    id,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(snippet)
    }

    fn delete(&self, id: &str) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        connection
            .execute("DELETE FROM snippets WHERE id = ?1", [id])
            .map_err(CommandError::database)?;
        Ok(())
    }
}

fn snippet_from_row(row: &Row<'_>) -> rusqlite::Result<Snippet> {
    let tags_json: String = row.get(4)?;
    Ok(Snippet {
        id: row.get(0)?,
        name: row.get(1)?,
        content: row.get(2)?,
        description: row.get(3)?,
        // Go List 忽略损坏的 tags JSON 并返回空数组。
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        is_global: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
pub async fn snippet_list(state: State<'_, SnippetState>) -> Result<Vec<Snippet>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list())
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn snippet_create(
    state: State<'_, SnippetState>,
    sync_state: State<'_, crate::sync::SyncState>,
    request: SnippetCreateRequest,
) -> Result<Snippet, CommandError> {
    let state = state.inner().clone();
    let snippet = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(snippet)
}

#[tauri::command]
pub async fn snippet_update(
    state: State<'_, SnippetState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
    request: SnippetUpdateRequest,
) -> Result<Snippet, CommandError> {
    let state = state.inner().clone();
    let snippet = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(snippet)
}

#[tauri::command]
pub async fn snippet_delete(
    state: State<'_, SnippetState>,
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

    fn state() -> (tempfile::TempDir, SnippetState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let state = SnippetState::new(database);
        (directory, state)
    }

    #[test]
    fn crud_preserves_defaults_and_partial_updates() {
        let (_directory, state) = state();
        let created = state
            .create(SnippetCreateRequest {
                name: "磁盘".into(),
                content: "df -h".into(),
                description: String::new(),
                tags: vec![],
                is_global: None,
            })
            .unwrap();
        assert!(created.is_global);
        assert!(created.tags.is_empty());

        let updated = state
            .update(
                &created.id,
                SnippetUpdateRequest {
                    name: Some("磁盘空间".into()),
                    content: None,
                    description: None,
                    tags: Some(vec!["linux".into()]),
                    is_global: Some(false),
                },
            )
            .unwrap();
        assert_eq!(updated.name, "磁盘空间");
        assert_eq!(updated.content, "df -h");
        assert_eq!(updated.tags, vec!["linux"]);
        assert!(!updated.is_global);
        assert_eq!(state.list().unwrap(), vec![updated.clone()]);

        state.delete(&created.id).unwrap();
        assert!(state.list().unwrap().is_empty());
        // 与旧接口一致：删除不存在 ID 仍成功。
        state.delete(&created.id).unwrap();
    }

    #[test]
    fn create_validation_matches_go_handler() {
        let (_directory, state) = state();
        let error = state
            .create(SnippetCreateRequest {
                name: String::new(),
                content: "pwd".into(),
                description: String::new(),
                tags: vec![],
                is_global: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(error.message, "name and content are required");
    }

    #[test]
    fn update_missing_id_matches_existing_error_contract() {
        let (_directory, state) = state();
        let error = state
            .update(
                "missing",
                SnippetUpdateRequest {
                    name: None,
                    content: None,
                    description: None,
                    tags: None,
                    is_global: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "DB_ERROR");
    }
}
