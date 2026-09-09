use rusqlite::{params, OptionalExtension, Row};

use crate::{error::CommandError, infrastructure::database::Database};

use super::Snippet;

#[derive(Clone)]
pub(super) struct SnippetRepository {
    database: Database,
}

impl SnippetRepository {
    pub(super) fn new(database: Database) -> Self {
        Self { database }
    }

    pub(super) fn list(&self) -> Result<Vec<Snippet>, CommandError> {
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

    pub(super) fn get(&self, id: &str) -> Result<Option<Snippet>, CommandError> {
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

    pub(super) fn insert(&self, snippet: &Snippet) -> Result<(), CommandError> {
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
        Ok(())
    }

    pub(super) fn update(&self, snippet: &Snippet) -> Result<(), CommandError> {
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
                    snippet.id,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn delete(&self, id: &str) -> Result<(), CommandError> {
        self.database
            .connect()?
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
        // Preserve the legacy behavior: malformed tags become an empty list.
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        is_global: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
