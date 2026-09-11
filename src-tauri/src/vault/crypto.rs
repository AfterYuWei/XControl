//! Vault、Profile 与同步配置共用的 AES-256-GCM 加密核心。
//!
//! 兼容 Go 格式：标准 Base64 编码 `12-byte nonce || ciphertext || 16-byte tag`，
//! 不使用 AAD。密钥文件为标准 Base64 编码的 32-byte key，无尾随换行。

use std::{
    fs::OpenOptions,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use zeroize::Zeroizing;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("read key file {path}: {source}")]
    ReadKey {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("decode key file: {0}")]
    DecodeKey(base64::DecodeError),
    #[error("invalid key length: {0}")]
    InvalidKeyLength(usize),
    #[error("create key directory {path}: {source}")]
    CreateKeyDirectory {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("write key file {path}: {source}")]
    WriteKey {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("generate random bytes: {0}")]
    Random(String),
    #[error("decode base64: {0}")]
    DecodeCiphertext(base64::DecodeError),
    #[error("ciphertext too short")]
    CiphertextTooShort,
    #[error("decrypt: authentication failed")]
    Authentication,
    #[error("decrypted plaintext is not valid UTF-8: {0}")]
    InvalidUtf8(std::string::FromUtf8Error),
}

#[derive(Clone)]
pub struct Encryptor {
    key: Arc<Zeroizing<[u8; KEY_LEN]>>,
}

impl Encryptor {
    pub fn load_or_create(path: impl AsRef<Path>) -> Result<Self, CryptoError> {
        let key = load_or_create_key(path.as_ref())?;
        Ok(Self {
            key: Arc::new(Zeroizing::new(key)),
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let mut nonce = [0_u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|error| CryptoError::Random(error.to_string()))?;
        self.encrypt_with_nonce(plaintext.as_bytes(), nonce)
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String, CryptoError> {
        String::from_utf8(self.decrypt_bytes(encoded)?).map_err(CryptoError::InvalidUtf8)
    }

    fn decrypt_bytes(&self, encoded: &str) -> Result<Vec<u8>, CryptoError> {
        let raw = STANDARD
            .decode(encoded)
            .map_err(CryptoError::DecodeCiphertext)?;
        if raw.len() < NONCE_LEN {
            return Err(CryptoError::CiphertextTooShort);
        }
        let (nonce, body) = raw.split_at(NONCE_LEN);
        Ok(cipher(&self.key).decrypt(Nonce::from_slice(nonce), body)?)
    }

    fn encrypt_with_nonce(
        &self,
        plaintext: &[u8],
        nonce: [u8; NONCE_LEN],
    ) -> Result<String, CryptoError> {
        let body = cipher(&self.key).encrypt(Nonce::from_slice(&nonce), plaintext)?;
        let mut output = Vec::with_capacity(NONCE_LEN + body.len());
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&body);
        Ok(STANDARD.encode(output))
    }

    #[cfg(test)]
    fn from_key(key: [u8; KEY_LEN]) -> Self {
        Self {
            key: Arc::new(Zeroizing::new(key)),
        }
    }
}

fn cipher(key: &[u8; KEY_LEN]) -> Aes256Gcm {
    // `[u8; 32]` guarantees the only key length accepted by AES-256-GCM.
    Aes256Gcm::new(aes_gcm::Key::<Aes256Gcm>::from_slice(key))
}

impl From<aes_gcm::Error> for CryptoError {
    fn from(_: aes_gcm::Error) -> Self {
        Self::Authentication
    }
}

fn load_or_create_key(path: &Path) -> Result<[u8; KEY_LEN], CryptoError> {
    match std::fs::read(path) {
        Ok(data) => return decode_key(&data),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CryptoError::ReadKey {
                path: path.to_path_buf(),
                source,
            });
        }
    }

    let mut key = [0_u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|error| CryptoError::Random(error.to_string()))?;
    let encoded = STANDARD.encode(key);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent_was_missing = !parent.exists();
    std::fs::create_dir_all(parent).map_err(|source| CryptoError::CreateKeyDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    if parent_was_missing {
        set_private_directory_permissions(parent)?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_private_file_options(&mut options);
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(encoded.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|source| CryptoError::WriteKey {
                    path: path.to_path_buf(),
                    source,
                })?;
            Ok(key)
        }
        // Another initializer won the create_new race; use its complete key.
        Err(error) if error.kind() == ErrorKind::AlreadyExists => std::fs::read(path)
            .map_err(|source| CryptoError::ReadKey {
                path: path.to_path_buf(),
                source,
            })
            .and_then(|data| decode_key(&data)),
        Err(source) => Err(CryptoError::WriteKey {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn decode_key(data: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    // Go's base64 decoder ignores CR/LF. Preserve that behavior for key files
    // edited by tools that append a trailing newline, but reject other spaces.
    let compact = data
        .iter()
        .copied()
        .filter(|byte| *byte != b'\r' && *byte != b'\n')
        .collect::<Vec<_>>();
    let decoded = STANDARD.decode(compact).map_err(CryptoError::DecodeKey)?;
    decoded
        .try_into()
        .map_err(|bytes: Vec<u8>| CryptoError::InvalidKeyLength(bytes.len()))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), CryptoError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|source| {
        CryptoError::CreateKeyDirectory {
            path: path.to_path_buf(),
            source,
        }
    })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_: &Path) -> Result<(), CryptoError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_options(_: &mut OpenOptions) {}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPAT_PLAINTEXT: &str = r#"{"password":"päss-密碼","private_key":""}"#;
    const COMPAT_CIPHERTEXT: &str =
        "oKGio6SlpqeoqaqrnToMTDa4ddAQAaXpJQoDegPfdPU9MaXOICwKpA/ZHHezAiKgxEcqH2W+JrVopzM0NGBaW07Hb7hZBgiI";

    fn compatibility_encryptor() -> Encryptor {
        let key = std::array::from_fn(|index| index as u8);
        Encryptor::from_key(key)
    }

    #[test]
    fn deterministic_fixture_matches_go_layout() {
        let nonce = std::array::from_fn(|index| 0xa0 + index as u8);
        let encrypted = compatibility_encryptor()
            .encrypt_with_nonce(COMPAT_PLAINTEXT.as_bytes(), nonce)
            .unwrap();
        assert_eq!(encrypted, COMPAT_CIPHERTEXT);
        assert_eq!(
            compatibility_encryptor()
                .decrypt(COMPAT_CIPHERTEXT)
                .unwrap(),
            COMPAT_PLAINTEXT
        );
    }

    #[test]
    fn load_create_and_reload_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/key");
        let first = Encryptor::load_or_create(&path).unwrap();
        let encrypted = first.encrypt("secret-密碼").unwrap();
        let second = Encryptor::load_or_create(&path).unwrap();
        assert_eq!(second.decrypt(&encrypted).unwrap(), "secret-密碼");
        assert_eq!(std::fs::read_to_string(path).unwrap().len(), 44);
    }

    #[test]
    fn loads_go_base64_key_with_trailing_newline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("key");
        std::fs::write(&path, b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n").unwrap();
        let encryptor = Encryptor::load_or_create(path).unwrap();
        assert_eq!(
            encryptor.decrypt(COMPAT_CIPHERTEXT).unwrap(),
            COMPAT_PLAINTEXT
        );
    }

    #[test]
    fn rejects_invalid_key_and_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("key");
        std::fs::write(&path, STANDARD.encode([0_u8; 16])).unwrap();
        assert!(matches!(
            Encryptor::load_or_create(path),
            Err(CryptoError::InvalidKeyLength(16))
        ));

        let encryptor = compatibility_encryptor();
        assert!(matches!(
            encryptor.decrypt("not-base64"),
            Err(CryptoError::DecodeCiphertext(_))
        ));
        assert!(matches!(
            encryptor.decrypt(&STANDARD.encode([0_u8; 11])),
            Err(CryptoError::CiphertextTooShort)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn created_key_uses_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let key_directory = directory.path().join("private");
        let key_path = key_directory.join("key");
        Encryptor::load_or_create(&key_path).unwrap();
        assert_eq!(
            std::fs::metadata(key_directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
