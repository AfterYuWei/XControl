//! Mobile master-key persistence and atomic legacy-key migration.
//!
//! Ciphertext stays AES-256-GCM compatible. Android wraps the Base64 master
//! key with an Android Keystore AES key; iOS stores it as a Keychain generic
//! password. The legacy file is removed only after the secure copy reloads and
//! decrypts every persisted encrypted field successfully.

use std::path::Path;

use zeroize::Zeroizing;

use crate::{error::CommandError, infrastructure::database::Database, vault::Encryptor};

trait SecureKeyStore {
    fn load(&self) -> Result<Option<String>, String>;
    fn store(&self, value: &str) -> Result<(), String>;
}

#[cfg(mobile)]
struct MobileKeyStore<'a, R: tauri::Runtime>(&'a tauri_plugin_master_key_store::MasterKeyStore<R>);

#[cfg(mobile)]
impl<R: tauri::Runtime> SecureKeyStore for MobileKeyStore<'_, R> {
    fn load(&self) -> Result<Option<String>, String> {
        self.0
            .load()
            .map(|response| response.value)
            .map_err(|error| error.to_string())
    }

    fn store(&self, value: &str) -> Result<(), String> {
        self.0
            .store(tauri_plugin_master_key_store::StoreRequest { value })
            .map_err(|error| error.to_string())
    }
}

#[cfg(mobile)]
pub(crate) fn load_or_create(
    app: &tauri::AppHandle,
    database: &Database,
    legacy_path: &Path,
) -> Result<Encryptor, CommandError> {
    use tauri_plugin_master_key_store::MasterKeyStoreExt;

    load_or_create_with_store(
        &MobileKeyStore(app.master_key_store()),
        database,
        legacy_path,
    )
}

fn load_or_create_with_store(
    store: &impl SecureKeyStore,
    database: &Database,
    legacy_path: &Path,
) -> Result<Encryptor, CommandError> {
    if let Some(encoded) = store.load().map_err(|error| secure_error("load", error))? {
        let encoded = Zeroizing::new(encoded);
        let encryptor = Encryptor::from_encoded_key(&encoded).map_err(crypto_error)?;
        validate_persisted_ciphertexts(database, &encryptor)?;
        if legacy_path.exists() {
            let legacy = Encryptor::load_existing(legacy_path).map_err(crypto_error)?;
            let legacy_encoded = Zeroizing::new(legacy.encoded_key());
            if legacy_encoded.as_str() != encoded.as_str() {
                return Err(CommandError::new(
                    "MASTER_KEY_MIGRATION",
                    "secure and legacy master keys do not match",
                ));
            }
            remove_legacy_key(legacy_path)?;
        }
        return Ok(encryptor);
    }

    let (candidate, encoded) = if legacy_path.exists() {
        let encryptor = Encryptor::load_existing(legacy_path).map_err(crypto_error)?;
        validate_persisted_ciphertexts(database, &encryptor)?;
        let encoded = encryptor.encoded_key();
        (encryptor, encoded)
    } else {
        Encryptor::generate_for_secure_store().map_err(crypto_error)?
    };

    // A restored database without either key must fail before a new random key
    // is committed, otherwise the valid ciphertext would become unrecoverable.
    validate_persisted_ciphertexts(database, &candidate)?;
    let encoded = Zeroizing::new(encoded);
    store
        .store(encoded.as_str())
        .map_err(|error| secure_error("store", error))?;
    let verified = store
        .load()
        .map_err(|error| secure_error("verify", error))?
        .ok_or_else(|| {
            CommandError::new(
                "MASTER_KEY_STORE",
                "secure master key disappeared after storage",
            )
        })?;
    let verified = Zeroizing::new(verified);
    if verified.as_str() != encoded.as_str() {
        return Err(CommandError::new(
            "MASTER_KEY_STORE",
            "secure master key verification mismatch",
        ));
    }
    let verified_encryptor = Encryptor::from_encoded_key(&verified).map_err(crypto_error)?;
    validate_persisted_ciphertexts(database, &verified_encryptor)?;
    if legacy_path.exists() {
        remove_legacy_key(legacy_path)?;
    }
    drop(verified_encryptor);
    Ok(candidate)
}

fn validate_persisted_ciphertexts(
    database: &Database,
    encryptor: &Encryptor,
) -> Result<(), CommandError> {
    let connection = database.connect()?;
    let mut statement = connection
        .prepare(
            "SELECT 'vault',data FROM vault WHERE data!='' \
             UNION ALL SELECT 'profile-inline',inline_credential FROM profiles WHERE inline_credential!='' \
             UNION ALL SELECT 'profile-proxy',proxy_credential FROM profiles WHERE proxy_credential!='' \
             UNION ALL SELECT 'sync-provider',config FROM sync_providers WHERE config!='' \
             UNION ALL SELECT 'sync-password',value FROM sync_settings \
                 WHERE key='sync_password' AND value!=''",
        )
        .map_err(CommandError::database)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(CommandError::database)?;
    for row in rows {
        let (kind, ciphertext) = row.map_err(CommandError::database)?;
        encryptor.decrypt(&ciphertext).map_err(|_| {
            CommandError::new(
                "MASTER_KEY_VALIDATION",
                format!("master key cannot decrypt persisted {kind} data"),
            )
        })?;
    }
    Ok(())
}

fn remove_legacy_key(path: &Path) -> Result<(), CommandError> {
    std::fs::remove_file(path).map_err(|error| {
        CommandError::new(
            "MASTER_KEY_MIGRATION",
            format!("secure key verified but legacy key removal failed: {error}"),
        )
    })
}

fn secure_error(stage: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "MASTER_KEY_STORE",
        format!("secure master key {stage} failed: {error}"),
    )
}

fn crypto_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("MASTER_KEY_MIGRATION", error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct MemoryStore {
        value: Mutex<Option<String>>,
        reject_store: bool,
    }

    impl SecureKeyStore for MemoryStore {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(self.value.lock().expect("store").clone())
        }

        fn store(&self, value: &str) -> Result<(), String> {
            if self.reject_store {
                return Err("rejected".into());
            }
            *self.value.lock().expect("store") = Some(value.into());
            Ok(())
        }
    }

    fn fixture() -> (tempfile::TempDir, Database, std::path::PathBuf, Encryptor) {
        let directory = tempfile::tempdir().expect("tempdir");
        let database = Database::initialize(directory.path().join("eizhu.db")).expect("database");
        let key_path = directory.path().join("key");
        let encryptor = Encryptor::load_or_create(&key_path).expect("key");
        (directory, database, key_path, encryptor)
    }

    #[test]
    fn migrates_only_after_ciphertext_and_secure_reload_are_verified() {
        let (_directory, database, key_path, encryptor) = fixture();
        let ciphertext = encryptor.encrypt("secret").expect("encrypt");
        database
            .connect()
            .expect("connection")
            .execute(
                "INSERT INTO vault (id,type,data,name) VALUES ('v','password',?1,'test')",
                [ciphertext],
            )
            .expect("insert");
        let store = MemoryStore::default();
        let migrated = load_or_create_with_store(&store, &database, &key_path).expect("migration");
        assert_eq!(
            migrated
                .decrypt(&encryptor.encrypt("roundtrip").unwrap())
                .unwrap(),
            "roundtrip"
        );
        assert!(!key_path.exists());
        assert!(store.value.lock().expect("store").is_some());
    }

    #[test]
    fn secure_store_failure_keeps_the_legacy_key() {
        let (_directory, database, key_path, _encryptor) = fixture();
        let store = MemoryStore {
            reject_store: true,
            ..MemoryStore::default()
        };
        let error = load_or_create_with_store(&store, &database, &key_path)
            .err()
            .expect("failure");
        assert_eq!(error.code, "MASTER_KEY_STORE");
        assert!(key_path.exists());
    }

    #[test]
    fn wrong_legacy_key_never_reaches_secure_storage() {
        let (_directory, database, key_path, encryptor) = fixture();
        let ciphertext = encryptor.encrypt("secret").expect("encrypt");
        database
            .connect()
            .expect("connection")
            .execute(
                "INSERT INTO vault (id,type,data,name) VALUES ('v','password',?1,'test')",
                [ciphertext],
            )
            .expect("insert");
        std::fs::remove_file(&key_path).expect("remove old key");
        Encryptor::load_or_create(&key_path).expect("replacement key");
        let store = MemoryStore::default();
        let error = load_or_create_with_store(&store, &database, &key_path)
            .err()
            .expect("failure");
        assert_eq!(error.code, "MASTER_KEY_VALIDATION");
        assert!(key_path.exists());
        assert!(store.value.lock().expect("store").is_none());
    }
}
