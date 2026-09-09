use rusqlite::{params, params_from_iter, OptionalExtension, Row};

use crate::{error::CommandError, infrastructure::database::Database};

use super::ProfileRef;

#[derive(Clone)]
pub(super) struct VaultRepository {
    pub(super) database: Database,
}

pub(super) struct VaultRecord {
    pub(super) id: String,
    pub(super) entry_type: String,
    pub(super) data: String,
    pub(super) name: String,
    pub(super) username: String,
    pub(super) remark: String,
    pub(super) fingerprint: String,
    pub(super) created_at: String,
    pub(super) updated_at: Option<String>,
    pub(super) ref_count: i64,
}

impl VaultRepository {
    pub(super) fn new(database: Database) -> Self {
        Self { database }
    }

    pub(super) fn list(
        &self,
        entry_type: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<VaultRecord>, CommandError> {
        let connection = self.database.connect()?;
        let mut query = String::from(
            "SELECT v.id, v.type, v.data, v.name, v.username, v.remark, v.fingerprint, \
             v.created_at, v.updated_at, COUNT(p.id) \
             FROM vault v LEFT JOIN profiles p \
             ON p.vault_id = v.id AND p.auth_type = 'vault'",
        );
        let mut arguments = Vec::<String>::new();
        let mut conditions = Vec::new();
        if let Some(value) = entry_type.filter(|value| !value.is_empty()) {
            conditions.push("v.type = ?");
            arguments.push(value.to_owned());
        }
        if let Some(value) = q.filter(|value| !value.is_empty()) {
            conditions.push("(v.name LIKE ? OR v.remark LIKE ? OR v.username LIKE ?)");
            let pattern = format!("%{value}%");
            arguments.extend([pattern.clone(), pattern.clone(), pattern]);
        }
        if !conditions.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&conditions.join(" AND "));
        }
        query.push_str(
            " GROUP BY v.id, v.type, v.data, v.name, v.username, v.remark, \
             v.fingerprint, v.created_at, v.updated_at ORDER BY v.updated_at DESC",
        );
        let mut statement = connection.prepare(&query).map_err(CommandError::database)?;
        let rows = statement
            .query_map(params_from_iter(arguments.iter()), vault_record_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub(super) fn get(&self, id: &str) -> Result<Option<VaultRecord>, CommandError> {
        self.database
            .connect()?
            .query_row(
                "SELECT v.id, v.type, v.data, v.name, v.username, v.remark, v.fingerprint, \
                 v.created_at, v.updated_at, \
                 (SELECT COUNT(*) FROM profiles p WHERE p.auth_type = 'vault' AND p.vault_id = v.id) \
                 FROM vault v WHERE v.id = ?1",
                [id],
                vault_record_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    pub(super) fn insert(&self, record: &VaultRecord) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute(
                "INSERT INTO vault \
                 (id, type, data, fingerprint, name, username, remark, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    record.id,
                    record.entry_type,
                    record.data,
                    record.fingerprint,
                    record.name,
                    record.username,
                    record.remark,
                    record.created_at,
                    record.updated_at,
                ],
            )
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        Ok(())
    }

    pub(super) fn update(
        &self,
        record: &VaultRecord,
        cascade_username: bool,
    ) -> Result<(), CommandError> {
        let mut connection = self.database.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        transaction
            .execute(
                "UPDATE vault SET type=?1, data=?2, fingerprint=?3, name=?4, username=?5, \
                 remark=?6, updated_at=?7 WHERE id=?8",
                params![
                    record.entry_type,
                    record.data,
                    record.fingerprint,
                    record.name,
                    record.username,
                    record.remark,
                    record.updated_at,
                    record.id,
                ],
            )
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        if cascade_username {
            transaction
                .execute(
                    "UPDATE profiles SET username=?1, updated_at=?2 \
                     WHERE auth_type='vault' AND vault_id=?3",
                    params![record.username, record.updated_at, record.id],
                )
                .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        }
        transaction
            .commit()
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))
    }

    pub(super) fn delete(&self, id: &str) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute("DELETE FROM vault WHERE id=?1", [id])
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn references(&self, id: &str) -> Result<Vec<ProfileRef>, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare("SELECT id, name FROM profiles WHERE auth_type='vault' AND vault_id=?1")
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([id], |row| {
                Ok(ProfileRef {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub(super) fn secret(&self, id: &str) -> Result<Option<(String, String)>, CommandError> {
        self.database
            .connect()?
            .query_row("SELECT type, data FROM vault WHERE id=?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(CommandError::database)
    }
}

fn vault_record_from_row(row: &Row<'_>) -> rusqlite::Result<VaultRecord> {
    Ok(VaultRecord {
        id: row.get(0)?,
        entry_type: row.get(1)?,
        data: row.get(2)?,
        name: row.get(3)?,
        username: row.get(4)?,
        remark: row.get(5)?,
        fingerprint: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        ref_count: row.get(9)?,
    })
}
