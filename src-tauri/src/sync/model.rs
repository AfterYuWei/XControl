use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const STATUS_IDLE: &str = "idle";
pub const STATUS_SYNCING: &str = "syncing";
pub const STATUS_CONFLICT: &str = "conflict";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncVersion {
    pub id: String,
    pub version: i64,
    pub hash: String,
    pub size: i64,
    #[serde(skip)]
    pub file_path: String,
    pub origin: String,
    #[serde(default)]
    pub synced_to: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncVersionInfo {
    pub version: i64,
    pub hash: String,
    pub size: i64,
    pub created_at: String,
}

impl From<&SyncVersion> for SyncVersionInfo {
    fn from(value: &SyncVersion) -> Self {
        Self {
            version: value.version,
            hash: value.hash.clone(),
            size: value.size,
            created_at: value.created_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SyncSettings {
    pub sync_mode: String,
    pub conflict_policy: String,
    pub cloud_retention: String,
    pub local_keep_versions: i64,
    pub scheduled_enabled: bool,
    pub scheduled_interval_hours: i64,
    pub scheduled_daily_time: String,
    pub auto_backup_enabled: bool,
    pub change_debounce_seconds: i64,
    pub sync_password_set: bool,
    #[serde(default, skip_serializing)]
    pub sync_password: String,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            sync_mode: "auto".into(),
            conflict_policy: "prompt".into(),
            cloud_retention: "keep_forever".into(),
            local_keep_versions: 20,
            scheduled_enabled: false,
            scheduled_interval_hours: 0,
            scheduled_daily_time: String::new(),
            auto_backup_enabled: false,
            change_debounce_seconds: 30,
            sync_password_set: false,
            sync_password: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflictInfo {
    pub provider_id: String,
    pub provider_name: String,
    pub local: SyncVersionInfo,
    pub cloud: SyncVersionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncProviderMeta {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub authorized: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SyncProviderConfig {
    #[serde(rename = "type")]
    pub provider_type: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_endpoint: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_region: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_bucket: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_access_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_secret_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s3_prefix: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub s3_path_style: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub oauth_client_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub oauth_client_secret: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub oauth_access_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub oauth_refresh_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub oauth_expiry: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub drive_folder_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub onedrive_folder: String,
}

impl SyncProviderConfig {
    pub fn authorized(&self) -> bool {
        !self.oauth_refresh_token.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEvent {
    pub id: String,
    pub provider_id: String,
    pub action: String,
    pub version: i64,
    pub success: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub status: String,
    pub local_latest: Option<SyncVersionInfo>,
    pub cloud_latest: std::collections::HashMap<String, SyncVersionInfo>,
    pub providers: Vec<SyncProviderMeta>,
    pub conflict: Option<SyncConflictInfo>,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudVersionInfo {
    pub version: i64,
    pub hash: String,
    pub size: i64,
    pub object: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudIndex {
    pub format: String,
    pub version: i64,
    pub device_id: String,
    pub latest_version: i64,
    #[serde(default)]
    pub versions: Vec<CloudVersionInfo>,
    pub updated_at: String,
}

impl Default for CloudIndex {
    fn default() -> Self {
        Self {
            format: "xcontrol-sync-index".into(),
            version: 1,
            device_id: String::new(),
            latest_version: 0,
            versions: vec![],
            updated_at: "0001-01-01T00:00:00Z".into(),
        }
    }
}

impl CloudIndex {
    pub fn latest(&self) -> Option<&CloudVersionInfo> {
        self.versions.iter().max_by_key(|version| version.version)
    }

    pub fn contains_hash(&self, hash: &str) -> bool {
        self.versions.iter().any(|version| version.hash == hash)
    }

    pub fn hash_of(&self, number: i64) -> Option<&str> {
        self.versions
            .iter()
            .find(|version| version.version == number)
            .map(|version| version.hash.as_str())
    }

    pub fn add(&mut self, version: CloudVersionInfo) {
        if let Some(existing) = self
            .versions
            .iter_mut()
            .find(|existing| existing.version == version.version)
        {
            *existing = version;
        } else {
            self.versions.push(version);
        }
        self.recalculate();
    }

    pub fn remove(&mut self, number: i64) {
        self.versions.retain(|version| version.version != number);
        self.recalculate();
    }

    fn recalculate(&mut self) {
        self.latest_version = self.latest().map_or(0, |version| version.version);
        self.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
    }
}

fn is_false(value: &bool) -> bool {
    !value
}
