use std::collections::HashMap;

use chrono::{DateTime, Utc};
use tokio::task::JoinSet;

use crate::error::CommandError;

use super::{
    model::{
        CloudIndex, CloudVersionInfo, SyncConflictInfo, SyncSettings, SyncStatus, SyncVersion,
        SyncVersionInfo, STATUS_IDLE, STATUS_SYNCING,
    },
    provider::{object_name, CloudProvider},
    repository::ProviderRow,
    service::{SyncService, ORIGIN_CONFLICT_RESOLVE},
};

impl SyncService {
    fn provider(&self, row: ProviderRow) -> Result<CloudProvider, CommandError> {
        CloudProvider::new(row.meta.id, row.config, self.inner.repository.clone())
    }

    pub async fn status(&self) -> Result<SyncStatus, CommandError> {
        let mut status = self.local_status()?;
        status.cloud_latest = self.cloud_latest().await;
        Ok(status)
    }

    pub async fn cloud_latest(&self) -> HashMap<String, SyncVersionInfo> {
        let Ok(rows) = self.inner.repository.list_providers(true) else {
            return HashMap::new();
        };
        let mut tasks = JoinSet::new();
        for row in rows {
            let state = self.clone();
            tasks.spawn(async move {
                let id = row.meta.id.clone();
                let mut provider = state.provider(row).ok()?;
                let index =
                    tokio::time::timeout(std::time::Duration::from_secs(15), provider.read_index())
                        .await
                        .ok()?
                        .ok()?;
                index.latest().map(|latest| {
                    (
                        id,
                        SyncVersionInfo {
                            version: latest.version,
                            hash: latest.hash.clone(),
                            size: latest.size,
                            created_at: latest.created_at.clone(),
                        },
                    )
                })
            });
        }
        let mut output = HashMap::new();
        while let Some(result) = tasks.join_next().await {
            if let Ok(Some((id, version))) = result {
                output.insert(id, version);
            }
        }
        output
    }

    pub async fn sync_all(&self) -> Result<(), CommandError> {
        let _operation = self.inner.operation.try_enter()?;
        let settings = self.inner.repository.load_settings()?;
        let rows = self.inner.repository.list_providers(true)?;
        if rows.is_empty() {
            return Ok(());
        }
        self.inner.repository.set_status(STATUS_SYNCING)?;
        let mut tasks = JoinSet::new();
        for row in rows {
            let state = self.clone();
            let settings = settings.clone();
            tasks.spawn(async move {
                let id = row.meta.id.clone();
                let name = row.meta.name.clone();
                let mut provider = state.provider(row)?;
                let result = state.sync_with_provider(&mut provider, &settings).await;
                if let Err(error) = &result {
                    state
                        .inner
                        .repository
                        .log_event(&id, "sync", 0, false, &error.message);
                    eprintln!("cloud sync failed for {name}: {error}");
                }
                result
            });
        }
        let mut first_error = None;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Err(error)) if first_error.is_none() => first_error = Some(error),
                Err(error) if first_error.is_none() => {
                    first_error = Some(CommandError::new(
                        "SYNC_FAILED",
                        format!("同步任务异常结束: {error}"),
                    ));
                }
                _ => {}
            }
        }
        let _ = self.inner.repository.set_status(STATUS_IDLE);
        let _ = self.inner.repository.touch_last_sync();
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(())
    }

    pub async fn push_latest(&self) -> Result<(), CommandError> {
        let _operation = self.inner.operation.try_enter()?;
        self.push_latest_inner().await
    }

    async fn push_latest_inner(&self) -> Result<(), CommandError> {
        let Some(latest) = self.inner.repository.latest_version()? else {
            return Ok(());
        };
        let rows = self.inner.repository.list_providers(true)?;
        let mut tasks = JoinSet::new();
        for row in rows {
            let state = self.clone();
            let version = latest.clone();
            tasks.spawn(async move {
                let id = row.meta.id.clone();
                let mut provider = state.provider(row)?;
                let result = state.push_version(&mut provider, &version).await;
                if let Err(error) = &result {
                    state.inner.repository.log_event(
                        &id,
                        "push",
                        version.version,
                        false,
                        &error.message,
                    );
                }
                result
            });
        }
        let mut first_error = None;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Err(error)) if first_error.is_none() => first_error = Some(error),
                Err(error) if first_error.is_none() => {
                    first_error = Some(CommandError::new(
                        "SYNC_FAILED",
                        format!("推送任务异常结束: {error}"),
                    ));
                }
                _ => {}
            }
        }
        let _ = self.inner.repository.touch_last_sync();
        self.enforce_retention_with_cloud().await?;
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(())
    }

    async fn sync_with_provider(
        &self,
        provider: &mut CloudProvider,
        settings: &SyncSettings,
    ) -> Result<(), CommandError> {
        let index = provider.read_index().await?;
        let local = self.inner.repository.latest_version()?;
        match local {
            None if index.latest_version == 0 => Ok(()),
            None if settings.sync_mode == "auto" => {
                self.pull_version(provider, &index, index.latest_version)
                    .await
            }
            None => Ok(()),
            Some(local) if index.latest_version < local.version => {
                self.push_version(provider, &local).await
            }
            Some(local) if index.latest_version > local.version => {
                if index.contains_hash(&local.hash) {
                    if settings.sync_mode == "auto" {
                        self.pull_version(provider, &index, index.latest_version)
                            .await
                    } else {
                        Ok(())
                    }
                } else {
                    self.handle_fork(provider, &index, &local, settings).await
                }
            }
            Some(local) if index.hash_of(local.version) == Some(local.hash.as_str()) => {
                self.inner.repository.mark_synced(&local.id, provider.id())
            }
            Some(local) => self.handle_fork(provider, &index, &local, settings).await,
        }
    }

    async fn handle_fork(
        &self,
        provider: &mut CloudProvider,
        index: &CloudIndex,
        local: &SyncVersion,
        settings: &SyncSettings,
    ) -> Result<(), CommandError> {
        let Some(cloud) = index.latest() else {
            return self.push_version(provider, local).await;
        };
        if settings.conflict_policy == "latest" {
            if parse_time(&cloud.created_at) > parse_time(&local.created_at) {
                return self.pull_version(provider, index, cloud.version).await;
            }
            return self.push_version(provider, local).await;
        }
        self.inner.repository.set_conflict(Some(&SyncConflictInfo {
            provider_id: provider.id().to_owned(),
            provider_name: provider.name().to_owned(),
            local: SyncVersionInfo::from(local),
            cloud: SyncVersionInfo {
                version: cloud.version,
                hash: cloud.hash.clone(),
                size: cloud.size,
                created_at: cloud.created_at.clone(),
            },
        }))
    }

    pub async fn resolve_conflict(
        &self,
        choice: &str,
    ) -> Result<Option<SyncVersion>, CommandError> {
        let _operation = self.inner.operation.try_enter()?;
        if choice != "keep_local" && choice != "use_cloud" {
            return Err(CommandError::new(
                "INVALID_CHOICE",
                "choice 须为 keep_local | use_cloud",
            ));
        }
        let state = self.inner.repository.get_state()?;
        if state.conflict_json.is_empty() {
            return Err(CommandError::new("NO_CONFLICT", "存在待解决的版本冲突"));
        }
        let conflict: SyncConflictInfo = serde_json::from_str(&state.conflict_json)
            .map_err(|e| CommandError::new("SYNC_FAILED", format!("冲突记录损坏: {e}")))?;
        if choice == "use_cloud" {
            let row = self.inner.repository.get_provider(&conflict.provider_id)?;
            let mut provider = self.provider(row)?;
            let index = provider.read_index().await?;
            self.pull_version(&mut provider, &index, conflict.cloud.version)
                .await?;
        }
        let state = self.clone();
        let mut version = tokio::task::spawn_blocking(move || {
            state.create_version_inner(ORIGIN_CONFLICT_RESOLVE)
        })
        .await
        .map_err(join_error)??;
        if version.is_none() {
            version = self.inner.repository.latest_version()?;
        }
        if version.is_some() {
            self.push_latest_inner().await?;
        }
        self.inner.repository.set_conflict(None)?;
        self.inner.repository.log_event(
            "",
            "resolve",
            version.as_ref().map_or(0, |v| v.version),
            true,
            choice,
        );
        Ok(version)
    }

    async fn push_version(
        &self,
        provider: &mut CloudProvider,
        version: &SyncVersion,
    ) -> Result<(), CommandError> {
        let path = version.file_path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
            .await
            .map_err(join_error)?
            .map_err(|error| {
                CommandError::new("SYNC_FAILED", format!("打开版本文件失败: {error}"))
            })?;
        let object = object_name(version.version, &version.hash)?;
        provider.put_object(&object, bytes).await?;
        let mut index = provider.read_index().await?;
        index.device_id.clone_from(&self.inner.device_id);
        index.add(CloudVersionInfo {
            version: version.version,
            hash: version.hash.clone(),
            size: version.size,
            object,
            created_at: version.created_at.clone(),
        });
        provider.write_index(&index).await?;
        self.inner
            .repository
            .mark_synced(&version.id, provider.id())?;
        self.inner
            .repository
            .log_event(provider.id(), "push", version.version, true, "");
        Ok(())
    }

    async fn pull_version(
        &self,
        provider: &mut CloudProvider,
        index: &CloudIndex,
        number: i64,
    ) -> Result<(), CommandError> {
        let info = index
            .versions
            .iter()
            .find(|version| version.version == number)
            .cloned()
            .ok_or_else(|| {
                CommandError::new("SYNC_FAILED", format!("云端索引中不存在版本 v{number}"))
            })?;
        let bytes = provider.get_object(&info.object).await?;
        let password = self.inner.repository.load_settings()?.sync_password.clone();
        let state = self.clone();
        let restore_bytes = bytes.clone();
        let hash = info.hash.clone();
        tokio::task::spawn_blocking(move || {
            state.inner.backup.restore_sync_version(
                &restore_bytes,
                &password,
                &hash,
                "云端版本校验失败（hash 不匹配）",
            )
        })
        .await
        .map_err(join_error)??;

        let filename = object_name(info.version, &info.hash)?;
        let path = self.inner.backup_dir.join(filename);
        let write_path = path.clone();
        tokio::task::spawn_blocking(move || {
            super::service::write_private_file(&write_path, &bytes)
        })
        .await
        .map_err(join_error)?
        .map_err(|error| CommandError::new("SYNC_FAILED", format!("写入版本文件失败: {error}")))?;
        let version = SyncVersion {
            id: uuid::Uuid::new_v4().to_string(),
            version: info.version,
            hash: info.hash,
            size: info.size,
            file_path: path.display().to_string(),
            origin: "restore".into(),
            synced_to: vec![provider.id().to_owned()],
            created_at: info.created_at,
        };
        self.inner.repository.upsert_version(&version)?;
        self.inner
            .repository
            .ensure_next_version(version.version + 1)?;
        self.inner
            .repository
            .log_event(provider.id(), "pull", version.version, true, "");
        Ok(())
    }

    pub async fn test_provider(&self, id: &str) -> Result<(), CommandError> {
        let row = self.inner.repository.get_provider(id)?;
        let mut provider = self.provider(row)?;
        tokio::time::timeout(std::time::Duration::from_secs(30), provider.ping())
            .await
            .map_err(|_| CommandError::new("TEST_FAILED", "连接测试超时"))?
            .map_err(|error| CommandError::new("TEST_FAILED", error.message))
    }

    async fn delete_from_clouds(&self, version: &SyncVersion) {
        let Ok(settings) = self.inner.repository.load_settings() else {
            return;
        };
        if settings.cloud_retention != "mirror_local" {
            return;
        }
        for provider_id in &version.synced_to {
            let Ok(row) = self.inner.repository.get_provider(provider_id) else {
                continue;
            };
            let Ok(mut provider) = self.provider(row) else {
                continue;
            };
            let result = async {
                provider
                    .delete_object(&object_name(version.version, &version.hash)?)
                    .await?;
                let mut index = provider.read_index().await?;
                index.remove(version.version);
                provider.write_index(&index).await
            }
            .await;
            match result {
                Ok(()) => self.inner.repository.log_event(
                    provider_id,
                    "delete",
                    version.version,
                    true,
                    "mirror_local",
                ),
                Err(error) => self.inner.repository.log_event(
                    provider_id,
                    "delete",
                    version.version,
                    false,
                    &error.message,
                ),
            }
        }
    }

    pub async fn delete_version_with_cloud(
        &self,
        id: &str,
        force: bool,
    ) -> Result<(), CommandError> {
        let _operation = self.inner.operation.try_enter()?;
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
        self.delete_from_clouds(&version).await;
        self.delete_version(id, force)
    }

    async fn enforce_retention_with_cloud(&self) -> Result<(), CommandError> {
        let settings = self.inner.repository.load_settings()?;
        let keep = usize::try_from(settings.local_keep_versions).unwrap_or(usize::MAX);
        if settings.local_keep_versions <= 0 {
            return Ok(());
        }
        let versions = self.inner.repository.list_versions()?;
        if versions.len() <= keep {
            return Ok(());
        }
        for version in &versions[keep..] {
            if version.synced_to.is_empty() {
                continue;
            }
            self.delete_from_clouds(version).await;
            self.delete_version(&version.id, false)?;
        }
        Ok(())
    }
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

fn join_error(error: tokio::task::JoinError) -> CommandError {
    CommandError::new("SYNC_FAILED", format!("后台任务异常结束: {error}"))
}
