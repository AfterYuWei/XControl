use rusqlite::{params, OptionalExtension, Row};

use crate::{error::CommandError, infrastructure::database::Database};

use super::Group;

#[derive(Clone)]
pub(super) struct GroupRepository {
    pub(super) database: Database,
}

impl GroupRepository {
    pub(super) fn new(database: Database) -> Self {
        Self { database }
    }

    pub(super) fn list(&self) -> Result<Vec<Group>, CommandError> {
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

    pub(super) fn get(&self, id: &str) -> Result<Option<Group>, CommandError> {
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

    pub(super) fn insert(&self, group: &Group) -> Result<(), CommandError> {
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
        Ok(())
    }

    pub(super) fn update(&self, group: &Group) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE groups SET name=?1, parent_id=?2, icon=?3 WHERE id=?4",
                params![group.name, group.parent_id, group.icon, group.id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    /// Returns the number of profiles preventing deletion. The check and
    /// mutation intentionally share one transaction.
    pub(super) fn delete(&self, id: &str) -> Result<i64, CommandError> {
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
            return Ok(profile_count);
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
        transaction.commit().map_err(CommandError::database)?;
        Ok(0)
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
