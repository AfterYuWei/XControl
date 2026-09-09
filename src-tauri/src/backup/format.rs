use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::CommandError;

use super::model::{strip_credentials, BackupFile, BackupPayload};

pub(super) const FORMAT: &str = "xcontrol-backup";
pub(super) const VERSION: i64 = 1;
pub(super) const MODE_NONE: &str = "none";
pub(super) const MODE_ENCRYPTED: &str = "encrypted";
pub(super) const MODE_PLAIN: &str = "plain";
const AAD: &[u8] = b"xcontrol-backup:1";
const NONCE_LEN: usize = 12;

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct KdfParams {
    pub(super) algo: String,
    pub(super) salt: String,
    pub(super) time: u32,
    pub(super) memory: u32,
    pub(super) threads: u8,
}

impl KdfParams {
    pub(super) fn generate() -> Result<Self, CommandError> {
        let mut salt = [0_u8; 16];
        getrandom::fill(&mut salt)
            .map_err(|error| CommandError::new("KDF_FAILED", error.to_string()))?;
        Ok(Self {
            algo: "argon2id".into(),
            salt: STANDARD.encode(salt),
            time: 3,
            memory: 64 * 1024,
            threads: 2,
        })
    }

    pub(super) fn derive(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
        if self.algo != "argon2id" {
            return Err(format!("unsupported kdf algo: {}", self.algo));
        }
        let salt = STANDARD
            .decode(&self.salt)
            .map_err(|_| "invalid kdf salt".to_owned())?;
        if salt.is_empty() {
            return Err("invalid kdf salt".into());
        }
        if self.time == 0 || self.time > 100 {
            return Err(format!("invalid kdf time: {}", self.time));
        }
        if self.memory == 0 || self.memory > 1 << 20 {
            return Err(format!("invalid kdf memory: {}", self.memory));
        }
        if self.threads == 0 || self.threads > 16 {
            return Err(format!("invalid kdf threads: {}", self.threads));
        }
        let params = Params::new(self.memory, self.time, u32::from(self.threads), Some(32))
            .map_err(|error| error.to_string())?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = Zeroizing::new([0_u8; 32]);
        argon
            .hash_password_into(password.as_bytes(), &salt, key.as_mut())
            .map_err(|error| error.to_string())?;
        Ok(key)
    }
}

pub(super) struct ParsedBackup {
    pub(super) payload: BackupPayload,
    pub(super) mode: String,
    pub(super) exported_at: String,
}

pub(super) fn decode_backup_file(raw: &[u8], password: &str) -> Result<ParsedBackup, CommandError> {
    let mut file: BackupFile = serde_json::from_slice(raw)
        .map_err(|error| invalid_backup(format!("备份文件格式无效: {error}")))?;
    if file.format != FORMAT {
        return Err(invalid_backup("不是有效的 XControl 备份文件"));
    }
    if file.version > VERSION {
        return Err(invalid_backup(format!(
            "备份版本 {} 过新，当前仅支持 ≤ {VERSION}",
            file.version
        )));
    }
    let mode = file.credential_mode.clone();
    let mut payload = match mode.as_str() {
        MODE_ENCRYPTED => {
            if password.is_empty() {
                return Err(CommandError::new(
                    "PASSWORD_REQUIRED",
                    "该备份已加密，请输入导出密码",
                ));
            }
            let kdf = file
                .kdf
                .take()
                .ok_or_else(|| invalid_backup("加密备份缺少 kdf 参数"))?;
            let key = kdf
                .derive(password)
                .map_err(|error| invalid_backup(format!("kdf 参数无效: {error}")))?;
            let plaintext = decrypt_backup(&key, &file.payload)
                .map_err(|_| CommandError::new("INVALID_PASSWORD", "密码错误或备份文件已损坏"))?;
            serde_json::from_slice(&plaintext)
                .map_err(|error| invalid_backup(format!("备份内容损坏: {error}")))?
        }
        MODE_NONE | MODE_PLAIN => BackupPayload {
            groups: file.groups,
            vault: file.vault,
            profiles: file.profiles,
            snippets: file.snippets,
        },
        _ => {
            return Err(invalid_backup(format!(
                "未知的 credential_mode: {:?}",
                file.credential_mode
            )));
        }
    };
    if mode == MODE_NONE {
        strip_credentials(&mut payload);
    }
    Ok(ParsedBackup {
        payload,
        mode,
        exported_at: file.exported_at,
    })
}

pub(super) fn invalid_backup(message: impl Into<String>) -> CommandError {
    CommandError::new("INVALID_BACKUP_FORMAT", message)
}

pub(super) fn encrypt_backup(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let mut nonce = [0_u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    encrypt_backup_with_nonce(key, plaintext, nonce)
}

pub(super) fn encrypt_backup_with_nonce(
    key: &[u8; 32],
    plaintext: &[u8],
    nonce: [u8; NONCE_LEN],
) -> Result<String, String> {
    let cipher = Aes256Gcm::new(aes_gcm::Key::<Aes256Gcm>::from_slice(key));
    let body = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: AAD,
            },
        )
        .map_err(|_| "encrypt failed".to_owned())?;
    let mut output = Vec::with_capacity(NONCE_LEN + body.len());
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&body);
    Ok(STANDARD.encode(output))
}

pub(super) fn decrypt_backup(key: &[u8; 32], encoded: &str) -> Result<Vec<u8>, String> {
    let raw = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if raw.len() < NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce, body) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(aes_gcm::Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: body,
                aad: AAD,
            },
        )
        .map_err(|_| "decrypt failed".to_owned())
}
