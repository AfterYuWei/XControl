//! eizhu 备份领域：导出 `.eizhubackup`，并兼容导入旧 `.xcbackup` 格式。
//!
//! 数据库、Argon2id 和 AES-GCM 均在 Rust 阻塞线程执行；桌面端只通过文件路径
//! 交换大文件，不把备份正文送入 WebView IPC。

use std::collections::HashMap;

use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    audit::AuditRepository,
    error::CommandError,
    group::GroupService,
    infrastructure::database::Database,
    profile::ProfileService,
    vault::{Encryptor, VaultService},
};

use super::{
    format::{
        decode_backup_file, decrypt_backup_for_format, encrypt_backup, invalid_backup, KdfParams,
        ParsedBackup, FORMAT, LEGACY_FORMAT, MODE_ENCRYPTED, MODE_NONE, MODE_PLAIN, VERSION,
    },
    model::{
        strip_credentials, BackupFile, BackupGroup, BackupImportResult, BackupPayload,
        BackupPreview, BackupSnapshot, BackupStats,
    },
    repository::BackupRepository,
};

const STRATEGY_SKIP: &str = "skip";
const STRATEGY_OVERWRITE: &str = "overwrite";
const STRATEGY_REGENERATE: &str = "regenerate";
const MAX_BACKUP_SIZE: u64 = 50 << 20;

#[derive(Clone)]
pub(crate) struct BackupService {
    repository: BackupRepository,
    audit: AuditRepository,
    groups: GroupService,
    profiles: ProfileService,
    vault: VaultService,
}

impl BackupService {
    pub fn new(
        database: Database,
        encryptor: Encryptor,
        audit: AuditRepository,
        groups: GroupService,
        profiles: ProfileService,
        vault: VaultService,
    ) -> Self {
        Self {
            repository: BackupRepository::new(database, encryptor),
            audit,
            groups,
            profiles,
            vault,
        }
    }

    pub(crate) fn export_bytes(&self, mode: &str, password: &str) -> Result<Vec<u8>, CommandError> {
        let mode = if mode.is_empty() {
            MODE_ENCRYPTED
        } else {
            mode
        };
        if !matches!(mode, MODE_NONE | MODE_ENCRYPTED | MODE_PLAIN) {
            return Err(CommandError::new(
                "INVALID_MODE",
                "credentials 参数须为 none | encrypted | plain",
            ));
        }
        if mode == MODE_ENCRYPTED && password.is_empty() {
            return Err(CommandError::new(
                "PASSWORD_REQUIRED",
                "加密导出必须提供密码",
            ));
        }

        let mut payload = self
            .export_payload()
            .map_err(|error| CommandError::new("EXPORT_FAILED", error.message))?;
        let mut file = BackupFile {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: Utc::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
            credential_mode: mode.into(),
            ..BackupFile::default()
        };
        if mode == MODE_ENCRYPTED {
            let kdf = KdfParams::generate()?;
            let key = kdf
                .derive(password)
                .map_err(|error| CommandError::new("KDF_FAILED", error.to_string()))?;
            let plaintext = serde_json::to_vec(&payload)
                .map_err(|error| CommandError::new("EXPORT_FAILED", error.to_string()))?;
            file.payload = encrypt_backup(&key, &plaintext)
                .map_err(|error| CommandError::new("ENCRYPT_FAILED", error.to_string()))?;
            file.kdf = Some(kdf);
        } else {
            if mode == MODE_NONE {
                strip_credentials(&mut payload);
            }
            file.groups = payload.groups;
            file.vault = payload.vault;
            file.profiles = payload.profiles;
            file.snippets = payload.snippets;
        }
        serde_json::to_vec_pretty(&file)
            .map_err(|error| CommandError::new("EXPORT_FAILED", error.to_string()))
    }

    fn export_payload(&self) -> Result<BackupPayload, CommandError> {
        self.repository.export_payload()
    }

    /// Sync 版本沿用同一 `.eizhubackup` 加密格式，但使用紧凑 JSON，并以加密前业务
    /// payload 的 SHA-256 做跨设备去重（随机 salt/nonce 不影响 hash）。
    pub(crate) fn build_sync_version(
        &self,
        password: &str,
    ) -> Result<(Vec<u8>, String), CommandError> {
        let payload = self.export_payload()?;
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&payload)
                .map_err(|error| CommandError::new("SYNC_FAILED", error.to_string()))?,
        );
        let hash = hex::encode(Sha256::digest(plaintext.as_slice()));
        let kdf = KdfParams::generate()
            .map_err(|error| CommandError::new("SYNC_FAILED", error.message))?;
        let key = kdf
            .derive(password)
            .map_err(|error| CommandError::new("SYNC_FAILED", error.to_string()))?;
        let payload = encrypt_backup(&key, &plaintext)
            .map_err(|error| CommandError::new("SYNC_FAILED", error.to_string()))?;
        let file = BackupFile {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: Utc::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
            credential_mode: MODE_ENCRYPTED.into(),
            kdf: Some(kdf),
            payload,
            ..BackupFile::default()
        };
        let bytes = serde_json::to_vec(&file)
            .map_err(|error| CommandError::new("SYNC_FAILED", error.to_string()))?;
        Ok((bytes, hash))
    }

    /// 校验、解密并覆盖恢复一个 Sync 版本。hash 在任何数据库写入前验证。
    pub(crate) fn restore_sync_version(
        &self,
        raw: &[u8],
        password: &str,
        expected_hash: &str,
        mismatch_message: &str,
    ) -> Result<(), CommandError> {
        let mut file: BackupFile = serde_json::from_slice(raw).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("版本文件格式无效: {error}"))
        })?;
        if file.credential_mode != MODE_ENCRYPTED || file.kdf.is_none() {
            return Err(CommandError::new("SYNC_FAILED", "版本文件不是加密备份"));
        }
        if file.format != FORMAT && file.format != LEGACY_FORMAT {
            return Err(CommandError::new("SYNC_FAILED", "版本文件格式无效"));
        }
        let key = file
            .kdf
            .take()
            .expect("checked kdf")
            .derive(password)
            .map_err(|error| CommandError::new("SYNC_FAILED", error.to_string()))?;
        let plaintext = Zeroizing::new(
            decrypt_backup_for_format(&key, &file.payload, &file.format).map_err(|error| {
                CommandError::new(
                    "SYNC_FAILED",
                    format!("版本文件解密失败（同步密码可能已变更）: {error}"),
                )
            })?,
        );
        let hash = hex::encode(Sha256::digest(plaintext.as_slice()));
        if hash != expected_hash {
            return Err(CommandError::new("SYNC_FAILED", mismatch_message));
        }
        let payload = serde_json::from_slice(&plaintext)
            .map_err(|error| CommandError::new("SYNC_FAILED", format!("版本内容损坏: {error}")))?;
        self.import_payload(payload, MODE_ENCRYPTED, STRATEGY_OVERWRITE, false)
            .map(|_| ())
            .map_err(|error| {
                CommandError::new("SYNC_FAILED", format!("恢复数据失败: {}", error.message))
            })
    }

    fn parse_path(&self, path: &str, password: &str) -> Result<ParsedBackup, CommandError> {
        let metadata = std::fs::metadata(path)
            .map_err(|error| invalid_backup(format!("读取文件失败: {error}")))?;
        if metadata.len() > MAX_BACKUP_SIZE {
            return Err(invalid_backup("备份文件超过 50MB 限制"));
        }
        let raw = std::fs::read(path)
            .map_err(|error| invalid_backup(format!("读取文件失败: {error}")))?;
        decode_backup_file(&raw, password)
    }

    pub(crate) fn preview(
        &self,
        path: &str,
        password: &str,
    ) -> Result<BackupPreview, CommandError> {
        let parsed = self.parse_path(path, password)?;
        let conflicts = self
            .conflicts(&parsed.payload)
            .map_err(|error| CommandError::new("PREVIEW_FAILED", error.message))?;
        Ok(BackupPreview {
            credential_mode: parsed.mode,
            exported_at: parsed.exported_at,
            stats: stats(&parsed.payload),
            conflicts,
        })
    }

    fn conflicts(&self, payload: &BackupPayload) -> Result<BackupStats, CommandError> {
        self.repository.conflicts(payload)
    }

    pub(crate) fn import(
        &self,
        path: &str,
        strategy: &str,
        password: &str,
    ) -> Result<BackupImportResult, CommandError> {
        if !matches!(
            strategy,
            STRATEGY_SKIP | STRATEGY_OVERWRITE | STRATEGY_REGENERATE
        ) {
            return Err(CommandError::new(
                "IMPORT_FAILED",
                format!("unknown import strategy: {strategy}"),
            ));
        }
        let parsed = self.parse_path(path, password)?;
        self.import_payload(parsed.payload, &parsed.mode, strategy, true)
    }

    fn import_payload(
        &self,
        mut payload: BackupPayload,
        mode: &str,
        strategy: &str,
        record_audit: bool,
    ) -> Result<BackupImportResult, CommandError> {
        if strategy == STRATEGY_REGENERATE {
            remap_ids(&mut payload);
        }
        let group_order = topo_sort_groups(&payload.groups)
            .map_err(|error| CommandError::new("IMPORT_FAILED", error.to_string()))?;

        let mut result = self
            .repository
            .import_payload(&payload, strategy, &group_order)?;

        let group_snapshot = self.groups.list();
        let profile_snapshot = self.profiles.list(None, None);
        let vault_snapshot = self.vault.list(None, None);
        match (group_snapshot, profile_snapshot, vault_snapshot) {
            (Ok(groups), Ok(profiles), Ok(vault)) => {
                result.snapshot = Some(BackupSnapshot {
                    groups,
                    profiles,
                    vault,
                });
            }
            (groups, profiles, vault) => {
                result.snapshot_error = format!(
                    "groups: {}; profiles: {}; vault: {}",
                    result_error(groups),
                    result_error(profiles),
                    result_error(vault)
                );
            }
        }
        if record_audit {
            let _ = self.audit.record(
                "",
                "import",
                format!(
                    "mode={} strategy={} groups={} vault={} profiles={} snippets={}",
                    mode,
                    strategy,
                    result.imported.groups,
                    result.imported.vault,
                    result.imported.profiles,
                    result.imported.snippets
                ),
            );
        }
        Ok(result)
    }
}

fn topo_sort_groups(groups: &[BackupGroup]) -> Result<Vec<usize>, super::error::BackupError> {
    let by_id: HashMap<&str, usize> = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.id.as_str(), index))
        .collect();
    let mut state = HashMap::<&str, u8>::new();
    let mut ordered = Vec::with_capacity(groups.len());
    fn visit<'a>(
        index: usize,
        groups: &'a [BackupGroup],
        by_id: &HashMap<&'a str, usize>,
        state: &mut HashMap<&'a str, u8>,
        ordered: &mut Vec<usize>,
    ) -> Result<(), super::error::BackupError> {
        let group = &groups[index];
        match state.get(group.id.as_str()).copied().unwrap_or_default() {
            2 => return Ok(()),
            1 => {
                return Err(super::error::BackupError::InvalidGraph(format!(
                    "分组存在循环引用（group {}）",
                    group.id
                )))
            }
            _ => {}
        }
        state.insert(group.id.as_str(), 1);
        if let Some(parent) = by_id.get(group.parent_id.as_str()) {
            visit(*parent, groups, by_id, state, ordered)?;
        }
        state.insert(group.id.as_str(), 2);
        ordered.push(index);
        Ok(())
    }
    for index in 0..groups.len() {
        visit(index, groups, &by_id, &mut state, &mut ordered)?;
    }
    Ok(ordered)
}

fn remap_ids(payload: &mut BackupPayload) {
    let mut ids = HashMap::<String, String>::new();
    for id in payload
        .groups
        .iter()
        .map(|item| &item.id)
        .chain(payload.vault.iter().map(|item| &item.id))
        .chain(payload.profiles.iter().map(|item| &item.id))
        .chain(payload.snippets.iter().map(|item| &item.id))
    {
        ids.insert(id.clone(), uuid::Uuid::new_v4().to_string());
    }
    let remap = |id: &str| ids.get(id).cloned().unwrap_or_else(|| id.to_owned());
    for item in &mut payload.groups {
        item.id = remap(&item.id);
        item.parent_id = remap(&item.parent_id);
    }
    for item in &mut payload.vault {
        item.id = remap(&item.id);
    }
    for item in &mut payload.profiles {
        item.id = remap(&item.id);
        item.group_id = remap(&item.group_id);
        item.vault_id = remap(&item.vault_id);
        remap_jump_profile(&mut item.options, &ids);
    }
    for item in &mut payload.snippets {
        item.id = remap(&item.id);
    }
}

fn remap_jump_profile(options: &mut String, ids: &HashMap<String, String>) {
    let Ok(mut root) = serde_json::from_str::<Value>(options) else {
        return;
    };
    let Some(proxy) = root.get_mut("proxy").and_then(Value::as_object_mut) else {
        return;
    };
    if proxy.get("type").and_then(Value::as_str) != Some("jump") {
        return;
    }
    let Some(old) = proxy
        .get("jump_profile_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    if let Some(new) = ids.get(&old) {
        proxy.insert("jump_profile_id".into(), Value::String(new.clone()));
        if let Ok(encoded) = serde_json::to_string(&root) {
            *options = encoded;
        }
    }
}

fn stats(payload: &BackupPayload) -> BackupStats {
    BackupStats {
        groups: payload.groups.len(),
        vault: payload.vault.len(),
        profiles: payload.profiles.len(),
        snippets: payload.snippets.len(),
    }
}

fn result_error<T>(result: Result<T, CommandError>) -> String {
    result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "<nil>".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    use crate::backup::model::{BackupProfile, BackupVaultItem};
    use crate::{
        backup::{format::encrypt_backup_with_nonce, model::zero_time},
        vault::{encode_plaintext, Credential},
    };

    fn state() -> (tempfile::TempDir, BackupService, Database, Encryptor) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("eizhu.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let audit = AuditRepository::new(database.clone());
        let groups = GroupService::new(database.clone());
        let vault = VaultService::new(database.clone(), encryptor.clone(), audit.clone());
        let profiles =
            ProfileService::initialize(database.clone(), encryptor.clone(), vault.clone()).unwrap();
        (
            directory,
            BackupService::new(
                database.clone(),
                encryptor.clone(),
                audit,
                groups,
                profiles,
                vault,
            ),
            database,
            encryptor,
        )
    }

    #[test]
    fn argon2_and_aes_match_go_backup_fixture() {
        let kdf = KdfParams {
            algo: "argon2id".into(),
            salt: "AAECAwQFBgcICQoLDA0ODw==".into(),
            time: 3,
            memory: 65_536,
            threads: 2,
        };
        let key = kdf.derive("backup-pass").unwrap();
        let plaintext = br#"{"groups":[],"vault":[],"profiles":[],"snippets":[]}"#;
        let encoded = encrypt_backup_with_nonce(
            &key,
            plaintext,
            [
                0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab,
            ],
        )
        .unwrap();
        assert_eq!(
            decrypt_backup_for_format(&key, &encoded, FORMAT).unwrap(),
            plaintext
        );
        // 更名前的固定密文继续可解密，锁定 XControl 备份兼容性。
        let legacy = "oKGio6Slpqeoqaqr/5RhcBAxn6573Mt1ALrP+eBQaMiyP6akIvf0uu2nhlQEWMzq2uGXuaN4m96U4fmus8neeWDoJRipvaOWkgfJWCXp654=";
        assert_eq!(
            decrypt_backup_for_format(&key, legacy, LEGACY_FORMAT).unwrap(),
            plaintext
        );
    }

    #[test]
    fn encrypted_xcontrol_backup_is_import_compatible() {
        let file = BackupFile {
            format: LEGACY_FORMAT.into(),
            version: VERSION,
            exported_at: "2026-01-01T00:00:00Z".into(),
            credential_mode: MODE_ENCRYPTED.into(),
            kdf: Some(KdfParams {
                algo: "argon2id".into(),
                salt: "AAECAwQFBgcICQoLDA0ODw==".into(),
                time: 3,
                memory: 65_536,
                threads: 2,
            }),
            payload: "oKGio6Slpqeoqaqr/5RhcBAxn6573Mt1ALrP+eBQaMiyP6akIvf0uu2nhlQEWMzq2uGXuaN4m96U4fmus8neeWDoJRipvaOWkgfJWCXp654=".into(),
            ..BackupFile::default()
        };
        let raw = serde_json::to_vec(&file).unwrap();
        let parsed = decode_backup_file(&raw, "backup-pass").unwrap();

        assert!(parsed.payload.groups.is_empty());
        assert!(parsed.payload.vault.is_empty());
        assert!(parsed.payload.profiles.is_empty());
        assert!(parsed.payload.snippets.is_empty());
    }

    #[test]
    fn plain_export_preview_and_import_round_trip() {
        let (directory, state, database, _) = state();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO groups (id,name,icon,sort_order,created_at) \
                 VALUES ('g1','生产','folder',0,'2026-09-08T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO snippets (id,name,content,tags,is_global,created_at,updated_at) \
                 VALUES ('s1','磁盘','df -h','[]',1,'2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let bytes = state.export_bytes(MODE_PLAIN, "").unwrap();
        let path = directory.path().join("roundtrip.xcbackup");
        std::fs::write(&path, bytes).unwrap();
        let preview = state.preview(path.to_str().unwrap(), "").unwrap();
        assert_eq!(preview.stats.groups, 1);
        assert_eq!(preview.stats.snippets, 1);
        assert_eq!(preview.conflicts.groups, 1);

        let result = state
            .import(path.to_str().unwrap(), STRATEGY_REGENERATE, "")
            .unwrap();
        assert_eq!(result.imported.groups, 1);
        assert_eq!(result.imported.snippets, 1);
        assert_eq!(state.groups.list().unwrap().len(), 2);
    }

    #[test]
    fn credentials_proxy_and_vault_usernames_round_trip() {
        let (source_directory, source, source_database, source_encryptor) = state();
        let connection = source_database.connect().unwrap();
        let password_data = source_encryptor.encrypt("vault-secret").unwrap();
        let key_credential = Credential {
            password: String::new(),
            private_key: "private-key-material".into(),
            public_key: String::new(),
            passphrase: String::new(),
        };
        let (key_plaintext, key_fingerprint) =
            encode_plaintext(&key_credential, "private_key").unwrap();
        let key_data = source_encryptor.encrypt(&key_plaintext).unwrap();
        connection
            .execute(
                "INSERT INTO vault \
                 (id,type,data,fingerprint,name,username,remark,created_at,updated_at) VALUES \
                 ('v-password','password',?1,'','密码','','','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z'),\
                 ('v-key','private_key',?2,?3,'密钥','legacy-user','','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')",
                params![password_data, key_data, key_fingerprint],
            )
            .unwrap();
        let inline = source_encryptor
            .encrypt(r#"{"password":"inline-secret"}"#)
            .unwrap();
        let proxy = source_encryptor.encrypt("proxy-secret").unwrap();
        connection
            .execute(
                "INSERT INTO profiles \
                 (id,name,host,port,username,auth_type,inline_credential,proxy_credential,\
                  tags,options,created_at,updated_at) \
                 VALUES ('p-inline','内联','host',22,'root','password',?1,?2,'[]',\
                 '{\"host_key_fingerprint\":\"SHA256:test\",\"proxy\":{\"type\":\"socks5\",\"host\":\"proxy\",\"port\":1080,\"username\":\"alice\"}}',\
                 '2026-09-08T00:00:00Z','2026-09-08T00:00:00Z'),\
                 ('p-vault','共享','host',22,'deploy','vault','','','[]','{}',\
                 '2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')",
                params![inline, proxy],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE profiles SET vault_id='v-password' WHERE id='p-vault'",
                [],
            )
            .unwrap();
        drop(connection);

        let bytes = source.export_bytes(MODE_PLAIN, "").unwrap();
        let path = source_directory.path().join("credentials.xcbackup");
        std::fs::write(&path, bytes).unwrap();

        let (_destination_directory, destination, destination_database, destination_encryptor) =
            state();
        let result = destination
            .import(path.to_str().unwrap(), STRATEGY_SKIP, "")
            .unwrap();
        assert_eq!(result.imported.vault, 2);
        assert_eq!(result.imported.profiles, 2);

        let connection = destination_database.connect().unwrap();
        let (vault_data, vault_username): (String, String) = connection
            .query_row(
                "SELECT data,username FROM vault WHERE id='v-password'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            destination_encryptor.decrypt(&vault_data).unwrap(),
            "vault-secret"
        );
        assert_eq!(vault_username, "deploy");
        let key_username: String = connection
            .query_row("SELECT username FROM vault WHERE id='v-key'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(key_username.is_empty());
        let (inline, proxy, options): (String, String, String) = connection
            .query_row(
                "SELECT inline_credential,proxy_credential,options FROM profiles WHERE id='p-inline'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let decoded: Credential =
            serde_json::from_str(&destination_encryptor.decrypt(&inline).unwrap()).unwrap();
        assert_eq!(decoded.password, "inline-secret");
        assert_eq!(
            destination_encryptor.decrypt(&proxy).unwrap(),
            "proxy-secret"
        );
        assert!(options.contains("SHA256:test"));
    }

    #[test]
    fn regenerate_remaps_group_vault_and_jump_references() {
        let mut payload = BackupPayload {
            groups: vec![BackupGroup {
                id: "group".into(),
                name: "group".into(),
                parent_id: String::new(),
                icon: "folder".into(),
                sort_order: 0,
                created_at: zero_time(),
            }],
            vault: vec![BackupVaultItem {
                id: "vault".into(),
                name: "vault".into(),
                entry_type: "password".into(),
                username: "root".into(),
                remark: String::new(),
                fingerprint: String::new(),
                credential: Some(Credential {
                    password: "secret".into(),
                    private_key: String::new(),
                    public_key: String::new(),
                    passphrase: String::new(),
                }),
                created_at: zero_time(),
                updated_at: zero_time(),
            }],
            profiles: vec![
                backup_profile("target", "group", "vault", "{}"),
                backup_profile(
                    "dependent",
                    "group",
                    "vault",
                    r#"{"other":true,"proxy":{"type":"jump","jump_profile_id":"target"}}"#,
                ),
            ],
            snippets: vec![],
        };
        remap_ids(&mut payload);
        assert_ne!(payload.groups[0].id, "group");
        assert_ne!(payload.vault[0].id, "vault");
        assert_eq!(payload.profiles[0].group_id, payload.groups[0].id);
        assert_eq!(payload.profiles[1].vault_id, payload.vault[0].id);
        let options: Value = serde_json::from_str(&payload.profiles[1].options).unwrap();
        assert_eq!(
            options
                .pointer("/proxy/jump_profile_id")
                .and_then(Value::as_str),
            Some(payload.profiles[0].id.as_str())
        );
        assert_eq!(options.get("other"), Some(&Value::Bool(true)));
    }

    fn backup_profile(id: &str, group_id: &str, vault_id: &str, options: &str) -> BackupProfile {
        BackupProfile {
            id: id.into(),
            name: id.into(),
            host: "host".into(),
            port: 22,
            username: "root".into(),
            auth_type: "vault".into(),
            icon: String::new(),
            vault_id: vault_id.into(),
            inline_credential: None,
            proxy_password: String::new(),
            group_id: group_id.into(),
            tags: vec![],
            options: options.into(),
            note: String::new(),
            sort_order: 0,
            created_at: zero_time(),
            updated_at: zero_time(),
        }
    }

    #[test]
    fn encrypted_backup_maps_password_errors() {
        let (directory, state, _, _) = state();
        let bytes = state.export_bytes(MODE_ENCRYPTED, "secret").unwrap();
        let path = directory.path().join("encrypted.xcbackup");
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            state.preview(path.to_str().unwrap(), "").unwrap_err().code,
            "PASSWORD_REQUIRED"
        );
        assert_eq!(
            state
                .preview(path.to_str().unwrap(), "wrong")
                .unwrap_err()
                .code,
            "INVALID_PASSWORD"
        );
        assert_eq!(
            state
                .preview(path.to_str().unwrap(), "secret")
                .unwrap()
                .stats,
            BackupStats::default()
        );
    }

    #[test]
    fn group_cycles_are_rejected_before_writing() {
        let groups = vec![
            BackupGroup {
                id: "a".into(),
                name: "a".into(),
                parent_id: "b".into(),
                icon: "folder".into(),
                sort_order: 0,
                created_at: zero_time(),
            },
            BackupGroup {
                id: "b".into(),
                name: "b".into(),
                parent_id: "a".into(),
                icon: "folder".into(),
                sort_order: 0,
                created_at: zero_time(),
            },
        ];
        assert_eq!(
            topo_sort_groups(&groups).unwrap_err().to_string(),
            "分组存在循环引用（group a）"
        );
    }
}
