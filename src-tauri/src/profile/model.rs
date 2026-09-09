use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

const PROXY_DIRECT: &str = "direct";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProxyConfig {
    #[serde(rename = "type")]
    pub proxy_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub port: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jump_profile_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_password: bool,
}

impl ProxyConfig {
    pub(super) fn direct() -> Self {
        Self {
            proxy_type: PROXY_DIRECT.into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            jump_profile_id: String::new(),
            has_password: false,
        }
    }
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct ProxyInput {
    #[serde(default, rename = "type")]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: i64,
    #[serde(default)]
    pub username: String,
    pub password: Option<String>,
    #[serde(default)]
    pub jump_profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub icon: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub vault_id: String,
    pub proxy: ProxyConfig,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub group_id: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub options: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
    pub sort_order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    pub(super) inline_credential: String,
    #[serde(skip)]
    pub(super) proxy_credential: String,
}

/// Decrypted connection data held only for the lifetime of an SSH attempt.
pub(crate) struct ResolvedProfileNode {
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: String,
    pub private_key: String,
    pub passphrase: String,
    pub known_host_key: String,
    pub proxy_password: String,
    pub proxy: ProxyConfig,
    pub jump: Option<Box<ResolvedProfileNode>>,
}

impl Drop for ResolvedProfileNode {
    fn drop(&mut self) {
        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
        self.proxy_password.zeroize();
    }
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct ProfileCreateRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub vault_id: String,
    #[serde(default)]
    pub password: String,
    #[serde(default, rename = "private_key")]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    pub proxy: Option<ProxyInput>,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub options: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Default, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct ProfileUpdateRequest {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub icon: Option<String>,
    pub vault_id: Option<String>,
    pub password: Option<String>,
    #[serde(rename = "private_key")]
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub proxy: Option<ProxyInput>,
    pub group_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub options: Option<String>,
    pub note: Option<String>,
    #[serde(skip)]
    pub(super) inline_credential: Option<String>,
    #[serde(skip)]
    pub(super) proxy_credential: Option<String>,
}

fn is_zero_i64(value: &i64) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}
