use std::collections::HashMap;

use chrono::{Local, SecondsFormat};
use rusqlite::{params, OptionalExtension, Row};

use crate::{
    credential_crypto::Encryptor, error::CommandError, infrastructure::database::Database,
};

use super::model::{
    SyncConflictInfo, SyncEvent, SyncProviderConfig, SyncProviderMeta, SyncSettings, SyncVersion,
    STATUS_CONFLICT, STATUS_IDLE,
};

const VERSION_COLUMNS: &str = "id,version,hash,size,file_path,origin,synced_to,created_at";
const PROVIDER_COLUMNS: &str = "id,type,name,enabled,config,created_at,updated_at";

#[derive(Clone)]
pub struct SyncRepository {
    database: Database,
    encryptor: Encryptor,
}

pub struct SyncStateRow {
    pub status: String,
    pub last_sync_at: Option<String>,
    pub conflict_json: String,
}

#[derive(Clone)]
pub struct ProviderRow {
    pub meta: SyncProviderMeta,
    pub config: SyncProviderConfig,
}

impl SyncRepository {
    pub fn new(database: Database, encryptor: Encryptor) -> Self {
        Self {
            database,
            encryptor,
        }
    }

    pub fn next_version(&self) -> Result<i64, CommandError> {
        self.database
            .connect()?
            .query_row(
                "UPDATE sync_state SET next_version=next_version+1 WHERE id=1 \
                 RETURNING next_version-1",
                [],
                |row| row.get(0),
            )
            .map_err(CommandError::database)
    }

    pub fn add_version(&self, version: &SyncVersion) -> Result<(), CommandError> {
        let synced_to = serde_json::to_string(&version.synced_to).unwrap_or_else(|_| "[]".into());
        self.database
            .connect()?
            .execute(
                "INSERT INTO sync_versions \
                 (id,version,hash,size,file_path,origin,synced_to,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    version.id,
                    version.version,
                    version.hash,
                    version.size,
                    version.file_path,
                    version.origin,
                    synced_to,
                    version.created_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn latest_version(&self) -> Result<Option<SyncVersion>, CommandError> {
        self.database
            .connect()?
            .query_row(
                &format!(
                    "SELECT {VERSION_COLUMNS} FROM sync_versions ORDER BY version DESC LIMIT 1"
                ),
                [],
                version_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    pub fn get_version(&self, id: &str) -> Result<SyncVersion, CommandError> {
        self.database
            .connect()?
            .query_row(
                &format!("SELECT {VERSION_COLUMNS} FROM sync_versions WHERE id=?1"),
                [id],
                version_from_row,
            )
            .map_err(CommandError::database)
    }

    pub fn list_versions(&self) -> Result<Vec<SyncVersion>, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {VERSION_COLUMNS} FROM sync_versions ORDER BY version DESC"
            ))
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], version_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub fn delete_version(&self, id: &str) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute("DELETE FROM sync_versions WHERE id=?1", [id])
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn upsert_version(&self, version: &SyncVersion) -> Result<(), CommandError> {
        let synced_to = serde_json::to_string(&version.synced_to).unwrap_or_else(|_| "[]".into());
        self.database
            .connect()?
            .execute(
                "INSERT INTO sync_versions \
                 (id,version,hash,size,file_path,origin,synced_to,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
                 ON CONFLICT(version) DO UPDATE SET id=excluded.id,hash=excluded.hash,\
                 size=excluded.size,file_path=excluded.file_path,origin=excluded.origin,\
                 synced_to=excluded.synced_to,created_at=excluded.created_at",
                params![
                    version.id,
                    version.version,
                    version.hash,
                    version.size,
                    version.file_path,
                    version.origin,
                    synced_to,
                    version.created_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn mark_synced(&self, version_id: &str, provider_id: &str) -> Result<(), CommandError> {
        let mut version = self.get_version(version_id)?;
        if version.synced_to.iter().any(|id| id == provider_id) {
            return Ok(());
        }
        version.synced_to.push(provider_id.into());
        let raw = serde_json::to_string(&version.synced_to).unwrap_or_else(|_| "[]".into());
        self.database
            .connect()?
            .execute(
                "UPDATE sync_versions SET synced_to=?1 WHERE id=?2",
                params![raw, version_id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn ensure_next_version(&self, minimum: i64) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute(
                "UPDATE sync_state SET next_version=MAX(next_version,?1) WHERE id=1",
                [minimum],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn get_state(&self) -> Result<SyncStateRow, CommandError> {
        self.database
            .connect()?
            .query_row(
                "SELECT status,last_sync_at,conflict_json FROM sync_state WHERE id=1",
                [],
                |row| {
                    Ok(SyncStateRow {
                        status: row.get(0)?,
                        last_sync_at: row.get(1)?,
                        conflict_json: row.get(2)?,
                    })
                },
            )
            .map_err(CommandError::database)
    }

    pub fn set_status(&self, status: &str) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute("UPDATE sync_state SET status=?1 WHERE id=1", [status])
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn set_conflict(&self, conflict: Option<&SyncConflictInfo>) -> Result<(), CommandError> {
        let (raw, status) = match conflict {
            Some(conflict) => (
                serde_json::to_string(conflict).map_err(CommandError::database)?,
                STATUS_CONFLICT,
            ),
            None => (String::new(), STATUS_IDLE),
        };
        self.database
            .connect()?
            .execute(
                "UPDATE sync_state SET conflict_json=?1,status=?2 WHERE id=1",
                params![raw, status],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn touch_last_sync(&self) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute("UPDATE sync_state SET last_sync_at=?1 WHERE id=1", [now()])
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<SyncSettings, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare("SELECT key,value FROM sync_settings")
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(CommandError::database)?;
        let values = rows
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(CommandError::database)?;
        let mut settings = SyncSettings::default();
        let string = |key: &str| values.get(key).cloned().unwrap_or_default();
        let boolean =
            |key: &str, default: bool| values.get(key).map_or(default, |value| value == "1");
        let integer = |key: &str, default: i64| {
            values
                .get(key)
                .and_then(|value| value.parse().ok())
                .unwrap_or(default)
        };
        if let Some(value) = values.get("sync_mode").filter(|value| !value.is_empty()) {
            settings.sync_mode.clone_from(value);
        }
        if let Some(value) = values
            .get("conflict_policy")
            .filter(|value| !value.is_empty())
        {
            settings.conflict_policy.clone_from(value);
        }
        if let Some(value) = values
            .get("cloud_retention")
            .filter(|value| !value.is_empty())
        {
            settings.cloud_retention.clone_from(value);
        }
        settings.local_keep_versions = integer("local_keep_versions", 20);
        settings.scheduled_enabled = boolean("scheduled_enabled", false);
        settings.scheduled_interval_hours = integer("scheduled_interval_hours", 0);
        settings.scheduled_daily_time = string("scheduled_daily_time");
        settings.auto_backup_enabled = boolean("auto_backup_enabled", false);
        settings.change_debounce_seconds = integer("change_debounce_seconds", 30);
        if let Some(encrypted) = values
            .get("sync_password")
            .filter(|value| !value.is_empty())
        {
            settings.sync_password_set = true;
            settings.sync_password = self.encryptor.decrypt(encrypted).unwrap_or_default();
        }
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &SyncSettings) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        let upsert = |key: &str, value: &str| -> Result<(), CommandError> {
            connection
                .execute(
                    "INSERT INTO sync_settings (key,value) VALUES (?1,?2) \
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, value],
                )
                .map_err(CommandError::database)?;
            Ok(())
        };
        for (key, value) in [
            ("sync_mode", settings.sync_mode.clone()),
            ("conflict_policy", settings.conflict_policy.clone()),
            ("cloud_retention", settings.cloud_retention.clone()),
            (
                "local_keep_versions",
                settings.local_keep_versions.to_string(),
            ),
            (
                "scheduled_enabled",
                bool_string(settings.scheduled_enabled).into(),
            ),
            (
                "scheduled_interval_hours",
                settings.scheduled_interval_hours.to_string(),
            ),
            (
                "scheduled_daily_time",
                settings.scheduled_daily_time.clone(),
            ),
            (
                "auto_backup_enabled",
                bool_string(settings.auto_backup_enabled).into(),
            ),
            (
                "change_debounce_seconds",
                settings.change_debounce_seconds.to_string(),
            ),
        ] {
            upsert(key, &value)?;
        }
        if !settings.sync_password.is_empty() {
            let encrypted = self
                .encryptor
                .encrypt(&settings.sync_password)
                .map_err(|error| {
                    CommandError::new("DB_ERROR", format!("encrypt sync password: {error}"))
                })?;
            upsert("sync_password", &encrypted)?;
        }
        Ok(())
    }

    pub fn log_event(
        &self,
        provider_id: &str,
        action: &str,
        version: i64,
        success: bool,
        error: &str,
    ) {
        let Ok(connection) = self.database.connect() else {
            return;
        };
        let _ = connection.execute(
            "INSERT INTO sync_events \
             (id,provider_id,action,version,success,error,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                provider_id,
                action,
                version,
                success,
                error,
                now(),
            ],
        );
    }

    pub fn list_events(&self, limit: i64) -> Result<Vec<SyncEvent>, CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT id,provider_id,action,version,success,error,created_at \
                 FROM sync_events ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([if limit <= 0 { 50 } else { limit }], |row| {
                Ok(SyncEvent {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    action: row.get(2)?,
                    version: row.get(3)?,
                    success: row.get(4)?,
                    error: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub fn create_provider(
        &self,
        config: &SyncProviderConfig,
    ) -> Result<ProviderRow, CommandError> {
        let raw = serde_json::to_string(config).map_err(CommandError::database)?;
        let encrypted = self
            .encryptor
            .encrypt(&raw)
            .map_err(|error| CommandError::new("DB_ERROR", format!("加密配置失败: {error}")))?;
        let timestamp = now();
        let meta = SyncProviderMeta {
            id: uuid::Uuid::new_v4().to_string(),
            provider_type: config.provider_type.clone(),
            name: config.name.clone(),
            enabled: config.enabled,
            authorized: false,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.database
            .connect()?
            .execute(
                "INSERT INTO sync_providers \
                 (id,type,name,enabled,config,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    meta.id,
                    meta.provider_type,
                    meta.name,
                    meta.enabled,
                    encrypted,
                    meta.created_at,
                    meta.updated_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(ProviderRow {
            meta,
            config: config.clone(),
        })
    }

    pub fn get_provider(&self, id: &str) -> Result<ProviderRow, CommandError> {
        let connection = self.database.connect()?;
        let raw = connection
            .query_row(
                &format!("SELECT {PROVIDER_COLUMNS} FROM sync_providers WHERE id=?1"),
                [id],
                provider_raw_from_row,
            )
            .map_err(CommandError::database)?;
        self.decrypt_provider(raw)
    }

    pub fn list_providers(&self, enabled_only: bool) -> Result<Vec<ProviderRow>, CommandError> {
        let connection = self.database.connect()?;
        let query = if enabled_only {
            format!(
                "SELECT {PROVIDER_COLUMNS} FROM sync_providers WHERE enabled=1 ORDER BY created_at"
            )
        } else {
            format!("SELECT {PROVIDER_COLUMNS} FROM sync_providers ORDER BY created_at")
        };
        let mut statement = connection.prepare(&query).map_err(CommandError::database)?;
        let rows = statement
            .query_map([], provider_raw_from_row)
            .map_err(CommandError::database)?;
        rows.map(|row| row.map_err(CommandError::database))
            .map(|result| result.and_then(|raw| self.decrypt_provider(raw)))
            .collect()
    }

    pub fn update_provider(
        &self,
        id: &str,
        config: &SyncProviderConfig,
    ) -> Result<(), CommandError> {
        let existing = self.get_provider(id)?;
        let merged = merge_secrets(&existing.config, config);
        let raw = serde_json::to_string(&merged).map_err(CommandError::database)?;
        let encrypted = self
            .encryptor
            .encrypt(&raw)
            .map_err(|error| CommandError::new("DB_ERROR", format!("加密配置失败: {error}")))?;
        self.database
            .connect()?
            .execute(
                "UPDATE sync_providers SET type=?1,name=?2,enabled=?3,config=?4,\
                 updated_at=?5 WHERE id=?6",
                params![
                    merged.provider_type,
                    merged.name,
                    merged.enabled,
                    encrypted,
                    now(),
                    id,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn save_provider_config(
        &self,
        id: &str,
        config: &SyncProviderConfig,
    ) -> Result<(), CommandError> {
        let raw = serde_json::to_string(config).map_err(CommandError::database)?;
        let encrypted = self
            .encryptor
            .encrypt(&raw)
            .map_err(|error| CommandError::new("DB_ERROR", format!("加密配置失败: {error}")))?;
        self.database
            .connect()?
            .execute(
                "UPDATE sync_providers SET config=?1,updated_at=?2 WHERE id=?3",
                params![encrypted, now(), id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn delete_provider(&self, id: &str) -> Result<(), CommandError> {
        let changed = self
            .database
            .connect()?
            .execute("DELETE FROM sync_providers WHERE id=?1", [id])
            .map_err(CommandError::database)?;
        if changed == 0 {
            return Err(CommandError::new("DB_ERROR", "provider not found"));
        }
        Ok(())
    }

    fn decrypt_provider(&self, raw: ProviderRaw) -> Result<ProviderRow, CommandError> {
        let plain = self
            .encryptor
            .decrypt(&raw.encrypted)
            .map_err(|error| CommandError::new("DB_ERROR", format!("解密配置失败: {error}")))?;
        let config = serde_json::from_str(&plain)
            .map_err(|error| CommandError::new("DB_ERROR", format!("配置数据损坏: {error}")))?;
        Ok(ProviderRow {
            meta: SyncProviderMeta {
                id: raw.id,
                provider_type: raw.provider_type,
                name: raw.name,
                enabled: raw.enabled,
                authorized: false,
                created_at: raw.created_at,
                updated_at: raw.updated_at,
            },
            config,
        })
    }
}

struct ProviderRaw {
    id: String,
    provider_type: String,
    name: String,
    enabled: bool,
    encrypted: String,
    created_at: String,
    updated_at: String,
}

fn provider_raw_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderRaw> {
    Ok(ProviderRaw {
        id: row.get(0)?,
        provider_type: row.get(1)?,
        name: row.get(2)?,
        enabled: row.get(3)?,
        encrypted: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn version_from_row(row: &Row<'_>) -> rusqlite::Result<SyncVersion> {
    let synced_to: String = row.get(6)?;
    Ok(SyncVersion {
        id: row.get(0)?,
        version: row.get(1)?,
        hash: row.get(2)?,
        size: row.get(3)?,
        file_path: row.get(4)?,
        origin: row.get(5)?,
        synced_to: serde_json::from_str(&synced_to).unwrap_or_default(),
        created_at: row.get(7)?,
    })
}

fn merge_secrets(old: &SyncProviderConfig, new: &SyncProviderConfig) -> SyncProviderConfig {
    let mut output = new.clone();
    if output.password.is_empty() {
        output.password.clone_from(&old.password);
    }
    if output.s3_secret_key.is_empty() {
        output.s3_secret_key.clone_from(&old.s3_secret_key);
    }
    if output.oauth_client_secret.is_empty() {
        output
            .oauth_client_secret
            .clone_from(&old.oauth_client_secret);
    }
    output
        .oauth_access_token
        .clone_from(&old.oauth_access_token);
    output
        .oauth_refresh_token
        .clone_from(&old.oauth_refresh_token);
    output.oauth_expiry.clone_from(&old.oauth_expiry);
    if output.drive_folder_id.is_empty() {
        output.drive_folder_id.clone_from(&old.drive_folder_id);
    }
    if output.onedrive_folder.is_empty() {
        output.onedrive_folder.clone_from(&old.onedrive_folder);
    }
    output
}

fn bool_string(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}
