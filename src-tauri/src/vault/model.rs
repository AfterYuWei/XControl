use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct VaultItem {
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
pub(crate) struct ProfileRef {
    pub id: String,
    pub name: String,
}

#[derive(Default, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct Credential {
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

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct VaultWriteRequest {
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

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct GenerateKeyRequest {
    pub algo: String,
    pub bits: Option<usize>,
    #[serde(default)]
    pub passphrase: String,
}

#[derive(Serialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct GenerateKeyResponse {
    pub public_key: String,
    pub private_key: String,
    pub fingerprint: String,
}
