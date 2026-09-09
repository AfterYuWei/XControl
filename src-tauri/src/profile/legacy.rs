//! One-time compatibility migration for pre-Rust inline credentials.
//!
//! This is intentionally the only Profile boundary allowed to coordinate the
//! historical Profile/Vault storage representation directly.

use rusqlite::params;

use crate::{
    error::CommandError,
    infrastructure::database::Database,
    vault::{decode_plaintext, Encryptor},
};

pub(super) fn backfill_inline_credentials(
    database: &Database,
    encryptor: &Encryptor,
) -> Result<(), CommandError> {
    let mut connection = database.connect()?;
    let transaction = connection.transaction().map_err(CommandError::database)?;
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT p.id,p.vault_id,v.type,v.data FROM profiles p \
                 JOIN vault v ON v.id=p.vault_id WHERE p.auth_type!='vault' \
                 AND p.vault_id!='' AND (p.inline_credential='' OR p.inline_credential IS NULL)",
            )
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(CommandError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)?;
        rows
    };

    for (profile_id, vault_id, vault_type, encrypted_data) in rows {
        let plaintext = encryptor.decrypt(&encrypted_data).map_err(|error| {
            CommandError::new(
                "DB_ERROR",
                format!("decrypt legacy vault credential for profile {profile_id}: {error}"),
            )
        })?;
        let credential = decode_plaintext(&plaintext, &vault_type);
        let raw = serde_json::to_string(&credential).map_err(|error| {
            CommandError::new(
                "DB_ERROR",
                format!("encode inline credential for profile {profile_id}: {error}"),
            )
        })?;
        let inline = if raw == "{}" {
            String::new()
        } else {
            encryptor.encrypt(&raw).map_err(|error| {
                CommandError::new(
                    "DB_ERROR",
                    format!("encode inline credential for profile {profile_id}: {error}"),
                )
            })?
        };
        transaction
            .execute(
                "UPDATE profiles SET inline_credential=?1,vault_id='',\
                 updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                params![inline, profile_id],
            )
            .map_err(CommandError::database)?;
        let references: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE auth_type='vault' AND vault_id=?1",
                [&vault_id],
                |row| row.get(0),
            )
            .map_err(CommandError::database)?;
        if references == 0 {
            transaction
                .execute("DELETE FROM vault WHERE id=?1", [&vault_id])
                .map_err(CommandError::database)?;
        }
    }
    transaction.commit().map_err(CommandError::database)
}
