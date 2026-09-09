use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::{Local, SecondsFormat};
use serde::Serialize;

use crate::{backup::BackupService, error::CommandError};

use super::{
    error::SyncError,
    model::{
        SyncConflictInfo, SyncEvent, SyncProviderConfig, SyncProviderMeta, SyncSettings,
        SyncStatus, SyncVersion, SyncVersionInfo,
    },
    repository::SyncRepository,
};

pub const ORIGIN_MANUAL: &str = "manual";
pub const ORIGIN_SCHEDULED: &str = "scheduled";
pub const ORIGIN_SHUTDOWN: &str = "shutdown";
pub const ORIGIN_CHANGE: &str = "change";
pub const ORIGIN_CONFLICT_RESOLVE: &str = "conflict_resolve";
pub const ORIGIN_RESTORE: &str = "restore";

#[derive(Clone)]
pub(crate) struct SyncService {
    pub(super) inner: Arc<SyncInner>,
}

pub(super) struct SyncInner {
    pub(super) repository: SyncRepository,
    pub(super) backup: BackupService,
    pub(super) backup_dir: PathBuf,
    pub(super) device_id: String,
    pub(super) operation: OperationCoordinator,
    pub(super) oauth_states: Mutex<HashMap<String, super::oauth::OAuthState>>,
    pub(super) scheduler: Mutex<Option<super::scheduler::SchedulerRuntime>>,
}

#[derive(Default)]
pub(super) struct OperationCoordinator {
    lock: tokio::sync::Mutex<()>,
}

impl OperationCoordinator {
    pub(super) fn try_enter(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, SyncError> {
        self.lock.try_lock().map_err(|_| SyncError::InProgress)
    }
}

#[derive(Debug, Serialize)]
pub struct BackupNowResult {
    pub created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<SyncVersion>,
}

#[derive(Debug, Serialize)]
pub struct RestoreResult {
    pub restored: bool,
    pub version: Option<SyncVersion>,
}

impl SyncService {
    pub fn initialize(
        repository: SyncRepository,
        backup: BackupService,
        backup_dir: PathBuf,
    ) -> Result<Self, CommandError> {
        std::fs::create_dir_all(&backup_dir).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("create backup dir: {error}"))
        })?;
        set_private_directory_permissions(&backup_dir).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("create backup dir: {error}"))
        })?;
        Ok(Self {
            inner: Arc::new(SyncInner {
                repository,
                backup,
                backup_dir,
                device_id: uuid::Uuid::new_v4().to_string(),
                operation: OperationCoordinator::default(),
                oauth_states: Mutex::new(HashMap::new()),
                scheduler: Mutex::new(None),
            }),
        })
    }

    pub fn get_settings(&self) -> Result<SyncSettings, CommandError> {
        let mut settings = self.inner.repository.load_settings()?;
        settings.sync_password.clear();
        Ok(settings)
    }

    pub fn reveal_password(&self) -> Result<String, CommandError> {
        let settings = self.inner.repository.load_settings()?;
        if !settings.sync_password_set || settings.sync_password.is_empty() {
            return Err(CommandError::new("NO_PASSWORD", "尚未设置同步密码"));
        }
        Ok(settings.sync_password.clone())
    }

    pub fn save_settings(&self, mut settings: SyncSettings) -> Result<(), CommandError> {
        validate_settings(&mut settings)?;
        self.inner
            .repository
            .save_settings(&settings)
            .map_err(|error| CommandError::new("SETTINGS_FAILED", error.message))
    }

    pub fn local_status(&self) -> Result<SyncStatus, CommandError> {
        let state = self.inner.repository.get_state()?;
        let local_latest = self
            .inner
            .repository
            .latest_version()?
            .as_ref()
            .map(SyncVersionInfo::from);
        let conflict = if state.conflict_json.is_empty() {
            None
        } else {
            serde_json::from_str::<SyncConflictInfo>(&state.conflict_json).ok()
        };
        let providers = self.list_providers()?;
        Ok(SyncStatus {
            status: state.status,
            local_latest,
            cloud_latest: Default::default(),
            providers,
            conflict,
            last_sync_at: state.last_sync_at,
        })
    }

    pub fn list_versions(&self) -> Result<Vec<SyncVersion>, CommandError> {
        self.inner.repository.list_versions()
    }

    pub fn list_events(&self, limit: i64) -> Result<Vec<SyncEvent>, CommandError> {
        self.inner.repository.list_events(limit)
    }

    pub fn create_version(&self, origin: &str) -> Result<Option<SyncVersion>, CommandError> {
        let _operation = self.inner.operation.try_enter()?;
        self.create_version_inner(origin)
    }

    pub(super) fn create_version_inner(
        &self,
        origin: &str,
    ) -> Result<Option<SyncVersion>, CommandError> {
        let settings = self.inner.repository.load_settings()?;
        if settings.sync_password.is_empty() {
            return Err(password_required());
        }
        let (bytes, hash) = self
            .inner
            .backup
            .build_sync_version(&settings.sync_password)?;
        if self
            .inner
            .repository
            .latest_version()?
            .is_some_and(|latest| latest.hash == hash)
        {
            return Ok(None);
        }

        if self
            .inner
            .repository
            .latest_version()?
            .is_some_and(|latest| latest.hash == hash)
        {
            return Ok(None);
        }
        let number = self.inner.repository.next_version()?;
        let filename = format!("v{number:06}-{}.xcbackup", &hash[..12]);
        let path = self.inner.backup_dir.join(filename);
        write_private_file(&path, &bytes).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("write version file: {error}"))
        })?;
        let version = SyncVersion {
            id: uuid::Uuid::new_v4().to_string(),
            version: number,
            hash,
            size: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
            file_path: path.display().to_string(),
            origin: origin.into(),
            synced_to: vec![],
            created_at: now(),
        };
        if let Err(error) = self.inner.repository.add_version(&version) {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        self.inner
            .repository
            .log_event("", "backup", number, true, "");
        let _ = self.inner.repository.touch_last_sync();
        Ok(Some(version))
    }

    pub fn delete_version(&self, id: &str, force: bool) -> Result<(), CommandError> {
        let version = self
            .inner
            .repository
            .get_version(id)
            .map_err(|error| CommandError::new("DELETE_FAILED", error.message))?;
        if !force && version.synced_to.is_empty() {
            return Err(CommandError::new(
                "DELETE_FAILED",
                "该版本尚未同步到任何云端，删除后将无法恢复（可用 force 强制删除）",
            ));
        }
        if let Err(error) = std::fs::remove_file(&version.file_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(CommandError::new("DELETE_FAILED", error.to_string()));
            }
        }
        self.inner
            .repository
            .log_event("", "delete", version.version, true, "user");
        self.inner
            .repository
            .delete_version(id)
            .map_err(|error| CommandError::new("DELETE_FAILED", error.message))
    }

    pub fn restore_version(&self, id: &str) -> Result<Option<SyncVersion>, CommandError> {
        let _operation = self.inner.operation.try_enter()?;
        let settings = self.inner.repository.load_settings()?;
        let version = self.inner.repository.get_version(id)?;
        let bytes = std::fs::read(&version.file_path).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("读取版本文件失败: {error}"))
        })?;
        self.inner.backup.restore_sync_version(
            &bytes,
            &settings.sync_password,
            &version.hash,
            "版本文件校验失败（内容 hash 不匹配），文件可能已损坏或同步密码已变更",
        )?;
        self.inner
            .repository
            .log_event("", "restore", version.version, true, "");
        self.create_version_inner(ORIGIN_RESTORE)
    }

    pub fn list_providers(&self) -> Result<Vec<SyncProviderMeta>, CommandError> {
        self.inner
            .repository
            .list_providers(false)?
            .into_iter()
            .map(|mut row| {
                if matches!(row.config.provider_type.as_str(), "gdrive" | "onedrive") {
                    row.meta.authorized = row.config.authorized();
                }
                Ok(row.meta)
            })
            .collect()
    }

    pub fn create_provider(
        &self,
        config: SyncProviderConfig,
    ) -> Result<SyncProviderMeta, CommandError> {
        validate_provider(&config)?;
        self.inner
            .repository
            .create_provider(&config)
            .map(|row| row.meta)
            .map_err(|error| CommandError::new("INVALID_PROVIDER", error.message))
    }

    pub fn update_provider(
        &self,
        id: &str,
        config: SyncProviderConfig,
    ) -> Result<(), CommandError> {
        validate_provider(&config)
            .map_err(|error| CommandError::new("UPDATE_FAILED", error.message))?;
        self.inner
            .repository
            .update_provider(id, &config)
            .map_err(|error| CommandError::new("UPDATE_FAILED", error.message))
    }

    pub fn delete_provider(&self, id: &str) -> Result<(), CommandError> {
        self.inner
            .repository
            .delete_provider(id)
            .map_err(|error| CommandError::new("DELETE_FAILED", error.message))
    }
}

pub fn validate_settings(settings: &mut SyncSettings) -> Result<(), CommandError> {
    if !matches!(settings.sync_mode.as_str(), "manual" | "auto") {
        return Err(CommandError::new(
            "INVALID_SETTINGS",
            "sync_mode 须为 manual | auto",
        ));
    }
    if !matches!(settings.conflict_policy.as_str(), "prompt" | "latest") {
        return Err(CommandError::new(
            "INVALID_SETTINGS",
            "conflict_policy 须为 prompt | latest",
        ));
    }
    if !matches!(
        settings.cloud_retention.as_str(),
        "keep_forever" | "mirror_local"
    ) {
        return Err(CommandError::new(
            "INVALID_SETTINGS",
            "cloud_retention 须为 keep_forever | mirror_local",
        ));
    }
    if !settings.scheduled_daily_time.is_empty()
        && (settings.scheduled_daily_time.len() != 5
            || settings.scheduled_daily_time.as_bytes().get(2) != Some(&b':'))
    {
        return Err(CommandError::new(
            "INVALID_SETTINGS",
            "scheduled_daily_time 格式须为 HH:MM",
        ));
    }
    settings.change_debounce_seconds = settings.change_debounce_seconds.max(5);
    Ok(())
}

pub fn validate_provider(config: &SyncProviderConfig) -> Result<(), CommandError> {
    if config.name.is_empty() {
        return Err(CommandError::new("INVALID_PROVIDER", "名称不能为空"));
    }
    match config.provider_type.as_str() {
        "webdav" if config.endpoint.is_empty() => {
            Err(CommandError::new("INVALID_PROVIDER", "WebDAV 地址不能为空"))
        }
        "s3" if config.s3_bucket.is_empty() || config.s3_access_key.is_empty() => Err(
            CommandError::new("INVALID_PROVIDER", "S3 Bucket 与 AccessKey 不能为空"),
        ),
        "gdrive" | "onedrive" if config.oauth_client_id.is_empty() => Err(CommandError::new(
            "INVALID_PROVIDER",
            "OAuth Client ID 不能为空（需在对应云平台注册应用获取）",
        )),
        "webdav" | "s3" | "gdrive" | "onedrive" => Ok(()),
        other => Err(CommandError::new(
            "INVALID_PROVIDER",
            format!("暂不支持的云服务类型: {other}"),
        )),
    }
}

pub fn password_required() -> CommandError {
    CommandError::new("SYNC_PASSWORD_REQUIRED", "请先在同步设置中配置同步密码")
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audit::AuditRepository,
        group::GroupService,
        infrastructure::database::Database,
        profile::ProfileService,
        sync::repository::SyncRepository,
        vault::{Encryptor, VaultService},
    };

    fn state() -> (tempfile::TempDir, SyncService) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let audit = AuditRepository::new(database.clone());
        let groups = GroupService::new(database.clone());
        let vault = VaultService::new(database.clone(), encryptor.clone(), audit.clone());
        let profiles =
            ProfileService::initialize(database.clone(), encryptor.clone(), vault.clone()).unwrap();
        let backup = BackupService::new(
            database.clone(),
            encryptor.clone(),
            audit,
            groups,
            profiles,
            vault,
        );
        let repository = SyncRepository::new(database, encryptor);
        let state =
            SyncService::initialize(repository, backup, directory.path().join("backups")).unwrap();
        (directory, state)
    }

    #[test]
    fn settings_password_is_encrypted_preserved_and_hidden() {
        let (_directory, state) = state();
        let mut settings = SyncSettings::default();
        settings.sync_password = "secret-password".into();
        state.save_settings(settings).unwrap();
        assert!(state.get_settings().unwrap().sync_password.is_empty());
        assert!(state.get_settings().unwrap().sync_password_set);
        assert_eq!(state.reveal_password().unwrap(), "secret-password");

        let mut update = state.get_settings().unwrap();
        update.local_keep_versions = 7;
        state.save_settings(update).unwrap();
        assert_eq!(state.reveal_password().unwrap(), "secret-password");
    }

    #[test]
    fn create_deduplicates_and_restore_verifies_hash() {
        let (_directory, state) = state();
        let mut settings = SyncSettings::default();
        settings.sync_password = "secret-password".into();
        state.save_settings(settings).unwrap();
        let first = state.create_version(ORIGIN_MANUAL).unwrap().unwrap();
        assert_eq!(first.version, 1);
        assert!(state.create_version(ORIGIN_MANUAL).unwrap().is_none());
        assert!(Path::new(&first.file_path).exists());
        assert!(state.restore_version(&first.id).unwrap().is_none());

        std::fs::write(&first.file_path, b"corrupt").unwrap();
        assert!(state.restore_version(&first.id).is_err());
    }

    #[test]
    fn unsynced_versions_require_force_to_delete() {
        let (_directory, state) = state();
        let mut settings = SyncSettings::default();
        settings.sync_password = "secret-password".into();
        state.save_settings(settings).unwrap();
        let version = state.create_version(ORIGIN_MANUAL).unwrap().unwrap();
        assert_eq!(
            state.delete_version(&version.id, false).unwrap_err().code,
            "DELETE_FAILED"
        );
        state.delete_version(&version.id, true).unwrap();
        assert!(state.list_versions().unwrap().is_empty());
    }

    #[test]
    fn operation_coordinator_rejects_overlapping_mutations() {
        let (_directory, state) = state();
        let _operation = state.inner.operation.try_enter().unwrap();
        assert_eq!(
            state.create_version(ORIGIN_MANUAL).unwrap_err().code,
            "SYNC_IN_PROGRESS"
        );
    }

    #[test]
    fn scheduler_requests_report_when_runtime_is_stopped() {
        let (_directory, state) = state();
        assert_eq!(
            state.request_sync().unwrap_err().code,
            "SYNC_SCHEDULER_STOPPED"
        );
    }

    #[test]
    fn scheduler_starts_without_an_entered_runtime() {
        let (_directory, state) = state();
        let runtime = tokio::runtime::Runtime::new().unwrap();

        state.start_scheduler(runtime.handle()).unwrap();
        runtime.block_on(state.stop_scheduler());
    }

    #[test]
    fn validation_matches_go_contract() {
        let mut settings = SyncSettings::default();
        settings.change_debounce_seconds = 1;
        validate_settings(&mut settings).unwrap();
        assert_eq!(settings.change_debounce_seconds, 5);
        settings.sync_mode = "invalid".into();
        assert_eq!(
            validate_settings(&mut settings).unwrap_err().code,
            "INVALID_SETTINGS"
        );
    }
}
