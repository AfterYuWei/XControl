//! 凭据库领域：加密存储、引用保护、SSH 密钥生成与 Tauri commands。
//!
//! 密文格式由 `credential_crypto` 保持与 Go 完全兼容；所有 SQLite 与密钥生成
//! 工作都在阻塞线程池执行，WebView 只接触最小化的领域 DTO。

use chrono::{Local, SecondsFormat};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use ssh_key::{
    private::{KeypairData, RsaKeypair},
    Algorithm, LineEnding, PrivateKey,
};

use crate::{audit::AuditRepository, error::CommandError, infrastructure::database::Database};

use super::{
    repository::{VaultRecord, VaultRepository},
    Credential, Encryptor, GenerateKeyRequest, GenerateKeyResponse, ProfileRef, VaultItem,
    VaultWriteRequest,
};

const PASSWORD: &str = "password";
const PRIVATE_KEY: &str = "private_key";

#[derive(Clone)]
pub(crate) struct VaultService {
    repository: VaultRepository,
    encryptor: Encryptor,
    audit: AuditRepository,
}

impl VaultService {
    pub fn new(database: Database, encryptor: Encryptor, audit: AuditRepository) -> Self {
        Self {
            repository: VaultRepository::new(database),
            encryptor,
            audit,
        }
    }

    pub(crate) fn list(
        &self,
        entry_type: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<VaultItem>, CommandError> {
        self.repository
            .list(entry_type, q)?
            .into_iter()
            .map(|record| Ok(self.item_from_record(record)))
            .collect()
    }

    pub(crate) fn get(&self, id: &str) -> Result<VaultItem, CommandError> {
        let record = self.repository.get(id)?.ok_or_else(not_found)?;
        Ok(self.item_from_record(record))
    }

    pub(crate) fn create(&self, request: VaultWriteRequest) -> Result<VaultItem, CommandError> {
        let (name, entry_type, username, remark, credential) = prepare_request(request)?;
        validate_credential(&credential, &entry_type)?;
        let (plaintext, fingerprint) = encode_plaintext(&credential, &entry_type)
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let encrypted = self
            .encryptor
            .encrypt(&plaintext)
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now();
        self.repository.insert(&VaultRecord {
            id: id.clone(),
            entry_type,
            data: encrypted,
            name: name.clone(),
            username,
            remark,
            fingerprint,
            created_at: now.clone(),
            updated_at: Some(now),
            ref_count: 0,
        })?;
        let _ = self
            .audit
            .record(&id, "vault_create", format!("name={name}"));
        self.get(&id)
            .map_err(|error| CommandError::new("DB_ERROR", error.message))
    }

    pub(crate) fn update(
        &self,
        id: &str,
        request: VaultWriteRequest,
    ) -> Result<VaultItem, CommandError> {
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
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;
        let encrypted = self
            .encryptor
            .encrypt(&plaintext)
            .map_err(|error| CommandError::new("VAULT_ERROR", error.to_string()))?;

        let now = now();
        self.repository.update(
            &VaultRecord {
                id: id.to_owned(),
                entry_type: entry_type.clone(),
                data: encrypted,
                name: name.clone(),
                username,
                remark,
                fingerprint,
                created_at: existing.created_at,
                updated_at: Some(now),
                ref_count: existing.ref_count,
            },
            entry_type == PASSWORD,
        )?;
        let _ = self
            .audit
            .record(id, "vault_update", format!("name={name}"));
        self.get(id)
            .map_err(|error| CommandError::new("DB_ERROR", error.message))
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), CommandError> {
        let references = self.references(id)?;
        if !references.is_empty() {
            return Err(
                CommandError::new("IN_USE", "vault entry is referenced by profiles")
                    .with_references(&references),
            );
        }
        self.repository.delete(id)?;
        let _ = self.audit.record(id, "vault_delete", "");
        Ok(())
    }

    pub(crate) fn references(&self, id: &str) -> Result<Vec<ProfileRef>, CommandError> {
        self.repository.references(id)
    }

    pub(crate) fn reveal(&self, id: &str) -> Result<Credential, CommandError> {
        let mut credential = self.resolve_for_profile(id).map_err(|_| not_found())?;
        credential.public_key = credential.public_key.trim().to_owned();
        if credential.public_key.is_empty() {
            credential.public_key = derive_authorized_public_key(&credential).unwrap_or_default();
        }
        let _ = self.audit.record(id, "vault_reveal", "");
        Ok(credential)
    }

    pub(crate) fn metadata(&self, id: &str) -> Result<(String, String), CommandError> {
        self.repository
            .get(id)?
            .map(|record| (record.entry_type, record.username))
            .ok_or_else(not_found)
    }

    /// Resolve a credential for an in-process SSH use case without producing a
    /// user-facing reveal audit event.
    pub(crate) fn resolve_for_profile(&self, id: &str) -> Result<Credential, CommandError> {
        let (entry_type, data) = self.repository.secret(id)?.ok_or_else(not_found)?;
        let plaintext = self.encryptor.decrypt(&data).map_err(|_| not_found())?;
        Ok(decode_plaintext(&plaintext, &entry_type))
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
) -> Result<(String, String), super::VaultError> {
    match entry_type {
        PASSWORD => Ok((credential.password.clone(), String::new())),
        PRIVATE_KEY => {
            let payload = serde_json::to_string(credential)?;
            let plaintext = format!("\u{1}{payload}");
            let digest = Sha256::digest(credential.private_key.as_bytes());
            Ok((plaintext, hex::encode(&digest[..8])))
        }
        other => Err(super::VaultError::UnsupportedType(other.to_owned())),
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

pub(crate) fn generate_key_pair(
    request: GenerateKeyRequest,
) -> Result<GenerateKeyResponse, CommandError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, VaultService) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("eizhu.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let audit = AuditRepository::new(database.clone());
        let state = VaultService::new(database, encryptor, audit);
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
            .repository
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
            .repository
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
            .repository
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
            .repository
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
        .err()
        .expect("invalid RSA size must fail");
        assert_eq!(error.message, "rsa bits must be 2048 or 4096");
        let error = generate_key_pair(GenerateKeyRequest {
            algo: "ecdsa".into(),
            bits: None,
            passphrase: String::new(),
        })
        .err()
        .expect("unsupported algorithm must fail");
        assert_eq!(error.message, "algo must be rsa or ed25519");
    }
}
