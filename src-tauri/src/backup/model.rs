use serde::{Deserialize, Serialize};

use crate::{
    group::Group,
    profile::Profile,
    vault::{Credential, VaultItem},
};

use super::format::KdfParams;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct BackupFile {
    pub(super) format: String,
    pub(super) version: i64,
    #[serde(default = "zero_time")]
    pub(super) exported_at: String,
    pub(super) credential_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) kdf: Option<KdfParams>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) payload: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) groups: Vec<BackupGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) vault: Vec<BackupVaultItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) profiles: Vec<BackupProfile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) snippets: Vec<BackupSnippet>,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct BackupPayload {
    #[serde(default)]
    pub(super) groups: Vec<BackupGroup>,
    #[serde(default)]
    pub(super) vault: Vec<BackupVaultItem>,
    #[serde(default)]
    pub(super) profiles: Vec<BackupProfile>,
    #[serde(default)]
    pub(super) snippets: Vec<BackupSnippet>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct BackupGroup {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) parent_id: String,
    pub(super) icon: String,
    pub(super) sort_order: i64,
    #[serde(default = "zero_time")]
    pub(super) created_at: String,
}

#[derive(Serialize, Deserialize)]
pub(super) struct BackupVaultItem {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(rename = "type")]
    pub(super) entry_type: String,
    pub(super) username: String,
    pub(super) remark: String,
    pub(super) fingerprint: String,
    pub(super) credential: Option<Credential>,
    #[serde(default = "zero_time")]
    pub(super) created_at: String,
    #[serde(default = "zero_time")]
    pub(super) updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub(super) struct BackupProfile {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) host: String,
    pub(super) port: i64,
    pub(super) username: String,
    pub(super) auth_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) icon: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) vault_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) inline_credential: Option<Credential>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) proxy_password: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) group_id: String,
    #[serde(default)]
    pub(super) tags: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) options: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) note: String,
    pub(super) sort_order: i64,
    #[serde(default = "zero_time")]
    pub(super) created_at: String,
    #[serde(default = "zero_time")]
    pub(super) updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct BackupSnippet {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) content: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) description: String,
    #[serde(default)]
    pub(super) tags: Vec<String>,
    pub(super) is_global: bool,
    #[serde(default = "zero_time")]
    pub(super) created_at: String,
    #[serde(default = "zero_time")]
    pub(super) updated_at: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub(super) struct BackupStats {
    pub(super) groups: usize,
    pub(super) vault: usize,
    pub(super) profiles: usize,
    pub(super) snippets: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct BackupPreview {
    pub(super) credential_mode: String,
    pub(super) exported_at: String,
    pub(super) stats: BackupStats,
    pub(super) conflicts: BackupStats,
}

#[derive(Debug, Serialize)]
pub(super) struct BackupSnapshot {
    pub(super) groups: Vec<Group>,
    pub(super) profiles: Vec<Profile>,
    pub(super) vault: Vec<VaultItem>,
}

#[derive(Debug, Serialize)]
pub(crate) struct BackupImportResult {
    pub(super) imported: BackupStats,
    pub(super) skipped: BackupStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) snapshot: Option<BackupSnapshot>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) snapshot_error: String,
}

pub(super) fn zero_time() -> String {
    "0001-01-01T00:00:00Z".into()
}

pub(super) fn strip_credentials(payload: &mut BackupPayload) {
    payload.vault.clear();
    for profile in &mut payload.profiles {
        profile.inline_credential = None;
        profile.proxy_password.clear();
        profile.vault_id.clear();
        if profile.auth_type == "vault" {
            profile.auth_type = "none".into();
        }
    }
}
