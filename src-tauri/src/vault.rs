//! 凭据库领域：加密存储、引用保护、SSH 密钥生成与 Tauri commands。
//!
//! 密文格式由 `credential_crypto` 保持与 Go 完全兼容；所有 SQLite 与密钥生成
//! 工作都在阻塞线程池执行，WebView 只接触最小化的领域 DTO。

use chrono::{Local, SecondsFormat};
use rand_core::OsRng;
use rusqlite::{params, params_from_iter, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh_key::{
    private::{KeypairData, RsaKeypair},
    Algorithm, LineEnding, PrivateKey,
};
use tauri::State;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{
    audit::AuditState, credential_crypto::Encryptor, database::Database, error::CommandError,
};

const PASSWORD: &str = "password";
const PRIVATE_KEY: &str = "private_key";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub username: String,
    pub remark: String,
    pub fingerprint: String,
    pub ref_count: i64,
    pub has_passphrase: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Default, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
pub struct Credential {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    #[serde(
        default,
        rename = "private_key",
        skip_serializing_if = "String::is_empty"
    )]
    pub private_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub public_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub passphrase: String,
}

#[derive(Debug, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct VaultWriteRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub remark: String,
    #[serde(default)]
    pub password: String,
    #[serde(default, rename = "private_key")]
    pub private_key: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub passphrase: String,
}

#[derive(Debug, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct GenerateKeyRequest {
    pub algo: String,
    pub bits: Option<usize>,
    #[serde(default)]
    pub passphrase: String,
}

#[derive(Debug, Serialize, Zeroize, ZeroizeOnDrop)]
pub struct GenerateKeyResponse {
    pub public_key: String,
    pub private_key: String,
    pub fingerprint: String,
}

#[derive(Clone)]
pub struct VaultState {
    database: Database,
    encryptor: Encryptor,
    audit: AuditState,
}

impl VaultState {
    pub fn new(database: Database, encryptor: Encryptor, audit: AuditState) -> Self {
        Self {
            database,
            encryptor,
            audit,
        }
    }

    pub(crate) fn list(
        &self,
        entry_type: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<VaultItem>, CommandError> {
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
        rows.map(|row| row.map_err(CommandError::database))
            .map(|result| result.map(|record| self.item_from_record(record)))
            .collect()
    }

    fn get(&self, id: &str) -> Result<VaultItem, CommandError> {
        let connection = self.database.connect()?;
        let record = connection
            .query_row(
                "SELECT v.id, v.type, v.data, v.name, v.username, v.remark, v.fingerprint, \
                 v.created_at, v.updated_at, \
                 (SELECT COUNT(*) FROM profiles p WHERE p.auth_type = 'vault' AND p.vault_id = v.id) \
                 FROM vault v WHERE v.id = ?1",
                [id],
                vault_record_from_row,
            )
            .optional()
            .map_err(CommandError::database)?
            .ok_or_else(not_found)?;
        Ok(self.item_from_record(record))
    }

    fn create(&self, request: VaultWriteRequest) -> Result<VaultItem, CommandError> {
        let (name, entry_type, username, remark, credential) = prepare_request(request)?;
        validate_credential(&credential, &entry_type)?;
        let (plaintext, fingerprint) = encode_plaintext(&credential, &entry_type)
            .map_err(|error| CommandError::new("VAULT_ERROR", error))?;
        let encrypted = self
            .encryptor
            .encrypt(&plaintext)
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now();
        let connection = self.database.connect()?;
        connection
            .execute(
                "INSERT INTO vault \
                 (id, type, data, fingerprint, name, username, remark, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    entry_type,
                    encrypted,
                    fingerprint,
                    name,
                    username,
                    remark,
                    now,
                ],
            )
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let _ = self
            .audit
            .record(&id, "vault_create", format!("name={name}"));
        self.get(&id)
            .map_err(|error| CommandError::new("DB_ERROR", error.message))
    }

    fn update(&self, id: &str, request: VaultWriteRequest) -> Result<VaultItem, CommandError> {
        let (name, entry_type, username, remark, credential) = prepare_request(request)?;
        let existing = self.get(id)?;
        if existing.entry_type != entry_type {
            return Err(CommandError::new(
                "VALIDATION",
                "credential type cannot be changed",
            ));
        }
        validate_credential(&credential, &entry_type)?;
        let (plaintext, fingerprint) = encode_plaintext(&credential, &entry_type)
            .map_err(|error| CommandError::new("VAULT_ERROR", error))?;
        let encrypted = self
            .encryptor
            .encrypt(&plaintext)
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;

        let now = now();
        let mut connection = self.database.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        transaction
            .execute(
                "UPDATE vault SET type=?1, data=?2, fingerprint=?3, name=?4, username=?5, \
                 remark=?6, updated_at=?7 WHERE id=?8",
                params![
                    entry_type,
                    encrypted,
                    fingerprint,
                    name,
                    username,
                    remark,
                    now,
                    id,
                ],
            )
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        if entry_type == PASSWORD {
            transaction
                .execute(
                    "UPDATE profiles SET username=?1, updated_at=?2 \
                     WHERE auth_type='vault' AND vault_id=?3",
                    params![username, now, id],
                )
                .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        }
        transaction
            .commit()
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let _ = self
            .audit
            .record(id, "vault_update", format!("name={name}"));
        self.get(id)
            .map_err(|error| CommandError::new("DB_ERROR", error.message))
    }

    fn delete(&self, id: &str) -> Result<(), CommandError> {
        let references = self.references(id)?;
        if !references.is_empty() {
            return Err(
                CommandError::new("IN_USE", "vault entry is referenced by profiles")
                    .with_references(&references),
            );
        }
        let connection = self.database.connect()?;
        connection
            .execute("DELETE FROM vault WHERE id=?1", [id])
            .map_err(CommandError::database)?;
        let _ = self.audit.record(id, "vault_delete", "");
        Ok(())
    }

    fn references(&self, id: &str) -> Result<Vec<ProfileRef>, CommandError> {
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

    fn reveal(&self, id: &str) -> Result<Credential, CommandError> {
        let connection = self.database.connect()?;
        let (entry_type, data): (String, String) = connection
            .query_row("SELECT type, data FROM vault WHERE id=?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(CommandError::database)?
            .ok_or_else(not_found)?;
        let plaintext = self.encryptor.decrypt(&data).map_err(|_| not_found())?;
        let mut credential = decode_plaintext(&plaintext, &entry_type);
        credential.public_key = credential.public_key.trim().to_owned();
        if credential.public_key.is_empty() {
            credential.public_key = derive_authorized_public_key(&credential).unwrap_or_default();
        }
        let _ = self.audit.record(id, "vault_reveal", "");
        Ok(credential)
    }

    fn item_from_record(&self, record: VaultRecord) -> VaultItem {
        let has_passphrase = self
            .encryptor
            .decrypt(&record.data)
            .map(|plaintext| {
                !decode_plaintext(&plaintext, &record.entry_type)
                    .passphrase
                    .is_empty()
            })
            .unwrap_or(false);
        VaultItem {
            id: record.id,
            name: record.name,
            entry_type: record.entry_type,
            username: record.username,
            remark: record.remark,
            fingerprint: record.fingerprint,
            ref_count: record.ref_count,
            has_passphrase,
            updated_at: record
                .updated_at
                .unwrap_or_else(|| record.created_at.clone()),
            created_at: record.created_at,
        }
    }
}

struct VaultRecord {
    id: String,
    entry_type: String,
    data: String,
    name: String,
    username: String,
    remark: String,
    fingerprint: String,
    created_at: String,
    updated_at: Option<String>,
    ref_count: i64,
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

fn prepare_request(
    mut request: VaultWriteRequest,
) -> Result<(String, String, String, String, Credential), CommandError> {
    if request.name.is_empty() {
        return Err(CommandError::new("VALIDATION", "name is required"));
    }
    if request.entry_type != PASSWORD && request.entry_type != PRIVATE_KEY {
        return Err(CommandError::new("VALIDATION", "invalid type"));
    }
    let username = if request.entry_type == PASSWORD {
        request.username.trim().to_owned()
    } else {
        String::new()
    };
    if request.entry_type == PASSWORD && username.is_empty() {
        return Err(CommandError::new(
            "VALIDATION",
            "username is required for password type",
        ));
    }
    request.public_key = request.public_key.trim().to_owned();
    let mut credential = Credential {
        password: std::mem::take(&mut request.password),
        private_key: std::mem::take(&mut request.private_key),
        public_key: std::mem::take(&mut request.public_key),
        passphrase: std::mem::take(&mut request.passphrase),
    };
    if request.entry_type == PRIVATE_KEY && credential.public_key.is_empty() {
        credential.public_key = derive_authorized_public_key(&credential).unwrap_or_default();
    }
    Ok((
        std::mem::take(&mut request.name),
        std::mem::take(&mut request.entry_type),
        username,
        std::mem::take(&mut request.remark),
        credential,
    ))
}

fn validate_credential(credential: &Credential, entry_type: &str) -> Result<(), CommandError> {
    match entry_type {
        PASSWORD if credential.password.is_empty() => Err(CommandError::new(
            "VALIDATION",
            "password is required for password type",
        )),
        PRIVATE_KEY if credential.private_key.is_empty() => Err(CommandError::new(
            "VALIDATION",
            "private_key is required for private_key type",
        )),
        _ => Ok(()),
    }
}

pub(crate) fn encode_plaintext(
    credential: &Credential,
    entry_type: &str,
) -> Result<(String, String), String> {
    match entry_type {
        PASSWORD => Ok((credential.password.clone(), String::new())),
        PRIVATE_KEY => {
            let payload = serde_json::to_string(credential).map_err(|error| error.to_string())?;
            let plaintext = format!("\u{1}{payload}");
            let digest = Sha256::digest(credential.private_key.as_bytes());
            Ok((plaintext, hex::encode(&digest[..8])))
        }
        other => Err(format!("unsupported vault type: {other}")),
    }
}

pub(crate) fn decode_plaintext(plaintext: &str, entry_type: &str) -> Credential {
    match entry_type {
        PASSWORD => Credential {
            password: plaintext.to_owned(),
            private_key: String::new(),
            public_key: String::new(),
            passphrase: String::new(),
        },
        PRIVATE_KEY => {
            if let Some(json) = plaintext.strip_prefix('\u{1}') {
                if let Ok(credential) = serde_json::from_str(json) {
                    return credential;
                }
            }
            let mut parts = plaintext.splitn(2, '\0');
            Credential {
                password: String::new(),
                private_key: parts.next().unwrap_or_default().to_owned(),
                public_key: String::new(),
                passphrase: parts.next().unwrap_or_default().to_owned(),
            }
        }
        _ => Credential::default(),
    }
}

fn derive_authorized_public_key(credential: &Credential) -> Result<String, ssh_key::Error> {
    if credential.private_key.trim().is_empty() {
        return Ok(String::new());
    }
    let private = PrivateKey::from_openssh(&credential.private_key)?;
    let decrypted;
    let private = if credential.passphrase.is_empty() {
        if private.is_encrypted() {
            return Err(ssh_key::Error::Encrypted);
        }
        &private
    } else {
        decrypted = private.decrypt(credential.passphrase.as_bytes())?;
        &decrypted
    };
    private
        .public_key()
        .to_openssh()
        .map(|key| key.trim().to_owned())
}

fn generate_key_pair(request: GenerateKeyRequest) -> Result<GenerateKeyResponse, CommandError> {
    let algo = request.algo.to_lowercase();
    let algo = if algo.is_empty() { "ed25519" } else { &algo };
    let mut rng = OsRng;
    let private = match algo {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        "rsa" => {
            let bits = request.bits.unwrap_or(4096);
            if bits != 2048 && bits != 4096 {
                return Err(CommandError::new(
                    "VALIDATION",
                    "rsa bits must be 2048 or 4096",
                ));
            }
            RsaKeypair::random(&mut rng, bits)
                .and_then(|keypair| PrivateKey::new(KeypairData::from(keypair), ""))
        }
        _ => {
            return Err(CommandError::new(
                "VALIDATION",
                "algo must be rsa or ed25519",
            ));
        }
    }
    .map_err(|error| CommandError::new("KEYGEN_ERROR", error.to_string()))?;

    let public_key = private
        .public_key()
        .to_openssh()
        .map_err(|error| CommandError::new("KEYGEN_ERROR", error.to_string()))?
        .trim()
        .to_owned();
    let public_bytes = private
        .public_key()
        .to_bytes()
        .map_err(|error| CommandError::new("KEYGEN_ERROR", error.to_string()))?;
    let fingerprint = hex::encode(&Sha256::digest(public_bytes)[..8]);
    let encoded_private = if request.passphrase.is_empty() {
        private
    } else {
        private
            .encrypt(&mut rng, request.passphrase.as_bytes())
            .map_err(|error| CommandError::new("KEYGEN_ERROR", error.to_string()))?
    };
    let private_key = encoded_private
        .to_openssh(LineEnding::LF)
        .map_err(|error| CommandError::new("KEYGEN_ERROR", error.to_string()))?
        .trim()
        .to_owned();

    Ok(GenerateKeyResponse {
        public_key,
        private_key,
        fingerprint,
    })
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn not_found() -> CommandError {
    CommandError::new("NOT_FOUND", "vault entry not found")
}

#[tauri::command]
pub async fn vault_list(
    state: State<'_, VaultState>,
    vault_type: Option<String>,
    q: Option<String>,
) -> Result<Vec<VaultItem>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list(vault_type.as_deref(), q.as_deref()))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn vault_get(
    state: State<'_, VaultState>,
    id: String,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.get(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn vault_create(
    state: State<'_, VaultState>,
    sync_state: State<'_, crate::sync::SyncState>,
    request: VaultWriteRequest,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    let item = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(item)
}

#[tauri::command]
pub async fn vault_update(
    state: State<'_, VaultState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
    request: VaultWriteRequest,
) -> Result<VaultItem, CommandError> {
    let state = state.inner().clone();
    let item = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(item)
}

#[tauri::command]
pub async fn vault_delete(
    state: State<'_, VaultState>,
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

#[tauri::command]
pub async fn vault_references(
    state: State<'_, VaultState>,
    id: String,
) -> Result<Vec<ProfileRef>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.references(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn vault_reveal(
    state: State<'_, VaultState>,
    id: String,
) -> Result<Credential, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.reveal(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn vault_generate_key_pair(
    request: GenerateKeyRequest,
) -> Result<GenerateKeyResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || generate_key_pair(request))
        .await
        .map_err(CommandError::database)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, VaultState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let audit = AuditState::new(database.clone());
        let state = VaultState::new(database, encryptor, audit);
        (directory, state)
    }

    fn password_request(name: &str, username: &str, password: &str) -> VaultWriteRequest {
        VaultWriteRequest {
            name: name.into(),
            entry_type: PASSWORD.into(),
            username: username.into(),
            remark: "生产环境".into(),
            password: password.into(),
            private_key: String::new(),
            public_key: String::new(),
            passphrase: String::new(),
        }
    }

    #[test]
    fn password_crud_search_audit_and_username_cascade() {
        let (_directory, state) = state();
        let item = state
            .create(password_request("数据库密码", "  admin  ", "secret"))
            .unwrap();
        assert_eq!(item.username, "admin");
        assert_eq!(item.fingerprint, "");
        assert_eq!(state.reveal(&item.id).unwrap().password, "secret");
        assert_eq!(state.list(Some(PASSWORD), Some("数据")).unwrap().len(), 1);

        state
            .database
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO profiles (id, name, host, username, auth_type, vault_id) \
                 VALUES ('p1', 'db', 'localhost', 'admin', 'vault', ?1)",
                [&item.id],
            )
            .unwrap();
        let updated = state
            .update(&item.id, password_request("数据库密码", "root", "next"))
            .unwrap();
        assert_eq!(updated.ref_count, 1);
        let username: String = state
            .database
            .connect()
            .unwrap()
            .query_row("SELECT username FROM profiles WHERE id='p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(username, "root");

        let error = state.delete(&item.id).unwrap_err();
        assert_eq!(error.code, "IN_USE");
        assert!(error.references.is_some());
        let audit_count: i64 = state
            .database
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_logs WHERE profile_id=?1",
                [&item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 3);
    }

    #[test]
    fn structured_and_legacy_private_keys_are_compatible() {
        let (_directory, state) = state();
        let credential = Credential {
            password: String::new(),
            private_key: "private-key-text".into(),
            public_key: "ssh-ed25519 public".into(),
            passphrase: "密语".into(),
        };
        let (plaintext, fingerprint) = encode_plaintext(&credential, PRIVATE_KEY).unwrap();
        assert!(plaintext.starts_with('\u{1}'));
        assert_eq!(fingerprint, "e1ecc25432ad0e4f");
        let decoded = decode_plaintext(&plaintext, PRIVATE_KEY);
        assert_eq!(decoded.passphrase, "密语");

        let encrypted = state
            .encryptor
            .encrypt("legacy-key\0legacy-passphrase")
            .unwrap();
        state
            .database
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO vault (id,type,data,name) VALUES ('legacy','private_key',?1,'legacy')",
                [encrypted],
            )
            .unwrap();
        let revealed = state.reveal("legacy").unwrap();
        assert_eq!(revealed.private_key, "legacy-key");
        assert_eq!(revealed.passphrase, "legacy-passphrase");
        assert!(state.get("legacy").unwrap().has_passphrase);
    }

    #[test]
    fn validation_and_type_immutability_match_http_contract() {
        let (_directory, state) = state();
        let error = state
            .create(password_request("", "root", "secret"))
            .unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            ("VALIDATION", "name is required")
        );
        let item = state
            .create(password_request("root", "root", "secret"))
            .unwrap();
        let mut request = password_request("root", "", "secret");
        assert_eq!(
            state.update(&item.id, request).unwrap_err().message,
            "username is required for password type"
        );
        request = password_request("root", "root", "secret");
        request.entry_type = PRIVATE_KEY.into();
        request.private_key = "key".into();
        assert_eq!(
            state.update(&item.id, request).unwrap_err().message,
            "credential type cannot be changed"
        );
        assert_eq!(state.get("missing").unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn ed25519_generation_returns_parseable_openssh_pair_and_fingerprint() {
        let response = generate_key_pair(GenerateKeyRequest {
            algo: "ED25519".into(),
            bits: None,
            passphrase: "secret".into(),
        })
        .unwrap();
        let private = PrivateKey::from_openssh(&response.private_key).unwrap();
        assert!(private.is_encrypted());
        let decrypted = private.decrypt("secret").unwrap();
        assert_eq!(
            decrypted.public_key().to_openssh().unwrap(),
            response.public_key
        );
        assert_eq!(response.fingerprint.len(), 16);
    }

    #[test]
    fn key_generation_validation_is_stable() {
        let error = generate_key_pair(GenerateKeyRequest {
            algo: "rsa".into(),
            bits: Some(1024),
            passphrase: String::new(),
        })
        .unwrap_err();
        assert_eq!(error.message, "rsa bits must be 2048 or 4096");
        let error = generate_key_pair(GenerateKeyRequest {
            algo: "ecdsa".into(),
            bits: None,
            passphrase: String::new(),
        })
        .unwrap_err();
        assert_eq!(error.message, "algo must be rsa or ed25519");
    }
}
