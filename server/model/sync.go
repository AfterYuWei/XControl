package model

import "time"

// Sync version origins (how a version was created).
const (
	SyncOriginManual          = "manual"
	SyncOriginScheduled       = "scheduled"
	SyncOriginShutdown        = "shutdown"
	SyncOriginChange          = "change"
	SyncOriginConflictResolve = "conflict_resolve"
	SyncOriginRestore         = "restore"
)

// Sync manager status values.
const (
	SyncStatusIdle     = "idle"
	SyncStatusSyncing  = "syncing"
	SyncStatusConflict = "conflict"
	SyncStatusError    = "error"
)

// SyncVersion is the metadata of one local backup version.
type SyncVersion struct {
	ID        string    `json:"id"`
	Version   int64     `json:"version"`
	Hash      string    `json:"hash"`
	Size      int64     `json:"size"`
	FilePath  string    `json:"-"`
	Origin    string    `json:"origin"`
	SyncedTo  []string  `json:"synced_to"`
	CreatedAt time.Time `json:"created_at"`
}

// SyncVersionInfo is the lightweight shape used in status cards / conflicts.
type SyncVersionInfo struct {
	Version   int64     `json:"version"`
	Hash      string    `json:"hash"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
}

func (v *SyncVersion) Info() SyncVersionInfo {
	return SyncVersionInfo{Version: v.Version, Hash: v.Hash, Size: v.Size, CreatedAt: v.CreatedAt}
}

// SyncSettings holds all user-configurable sync behaviour. Persisted as
// key/value rows in sync_settings; sync_password is stored AES-encrypted.
type SyncSettings struct {
	SyncMode              string `json:"sync_mode"`              // manual | auto
	ConflictPolicy        string `json:"conflict_policy"`        // prompt | latest
	CloudRetention        string `json:"cloud_retention"`        // keep_forever | mirror_local
	LocalKeepVersions     int    `json:"local_keep_versions"`    // <=0 means unlimited
	ScheduledEnabled      bool   `json:"scheduled_enabled"`      // master switch for scheduled backups
	ScheduledIntervalHrs  int    `json:"scheduled_interval_hours"` // 0 = disabled
	ScheduledDailyTime    string `json:"scheduled_daily_time"`   // "HH:MM", "" = disabled
	AutoBackupEnabled     bool   `json:"auto_backup_enabled"`    // shutdown + change triggers
	ChangeDebounceSeconds int    `json:"change_debounce_seconds"`
	SyncPasswordSet       bool   `json:"sync_password_set"`

	// SyncPassword is never serialized to clients; it is decrypted only
	// inside the sync manager when building version files.
	SyncPassword string `json:"-"`
}

// DefaultSyncSettings mirrors the confirmed decisions.
func DefaultSyncSettings() *SyncSettings {
	return &SyncSettings{
		SyncMode:              "auto",
		ConflictPolicy:        "prompt",
		CloudRetention:        "keep_forever",
		LocalKeepVersions:     20,
		ScheduledEnabled:      false,
		ScheduledIntervalHrs:  0,
		ScheduledDailyTime:    "",
		AutoBackupEnabled:     false,
		ChangeDebounceSeconds: 30,
	}
}

// SyncConflictInfo describes a local/remote fork awaiting user resolution.
type SyncConflictInfo struct {
	ProviderID   string          `json:"provider_id"`
	ProviderName string          `json:"provider_name"`
	Local        SyncVersionInfo `json:"local"`
	Cloud        SyncVersionInfo `json:"cloud"`
}

// SyncProviderMeta is the list/detail payload for a configured cloud provider
// (credentials never leave the server).
type SyncProviderMeta struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"` // webdav | s3 | gdrive | onedrive
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	// Authorized reports OAuth authorization state (gdrive/onedrive only).
	Authorized bool      `json:"authorized,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SyncProviderConfig is the decrypted configuration of one cloud provider.
// Secrets (passwords, keys, tokens) live here and are AES-encrypted at rest
// inside sync_providers.config.
type SyncProviderConfig struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`

	// WebDAV
	Endpoint string `json:"endpoint,omitempty"` // e.g. https://dav.example.com/remote.php/dav/files/user/xcontrol
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`

	// S3-compatible (AWS / MinIO / R2)
	S3Endpoint  string `json:"s3_endpoint,omitempty"` // empty = AWS default
	S3Region    string `json:"s3_region,omitempty"`
	S3Bucket    string `json:"s3_bucket,omitempty"`
	S3AccessKey string `json:"s3_access_key,omitempty"`
	S3SecretKey string `json:"s3_secret_key,omitempty"`
	S3Prefix    string `json:"s3_prefix,omitempty"` // e.g. "xcontrol/"
	S3PathStyle bool   `json:"s3_path_style,omitempty"` // MinIO 等需 path-style

	// OAuth2 (gdrive / onedrive) — client credentials are user-supplied
	// (each user registers their own OAuth app); tokens are filled by the
	// authorization flow and refreshed automatically.
	OAuthClientID     string    `json:"oauth_client_id,omitempty"`
	OAuthClientSecret string    `json:"oauth_client_secret,omitempty"`
	OAuthAccessToken  string    `json:"oauth_access_token,omitempty"`
	OAuthRefreshToken string    `json:"oauth_refresh_token,omitempty"`
	OAuthExpiry       time.Time `json:"oauth_expiry,omitempty"`

	// Google Drive: id of the backup folder (created on first use).
	DriveFolderID string `json:"drive_folder_id,omitempty"`
	// OneDrive: path of the backup folder under drive root.
	OneDriveFolder string `json:"onedrive_folder,omitempty"`
}

// Authorized reports whether an OAuth provider holds a refresh token.
func (c *SyncProviderConfig) Authorized() bool {
	return c.OAuthRefreshToken != ""
}

// SyncEvent is one audit entry of sync activity (errors included).
type SyncEvent struct {
	ID         string    `json:"id"`
	ProviderID string    `json:"provider_id"`
	Action     string    `json:"action"` // push | pull | delete | backup | restore | resolve
	Version    int64     `json:"version"`
	Success    bool      `json:"success"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// SyncStatusResponse powers the frontend status card.
type SyncStatusResponse struct {
	Status      string                     `json:"status"`
	LocalLatest *SyncVersionInfo           `json:"local_latest"`
	CloudLatest map[string]SyncVersionInfo `json:"cloud_latest"` // providerID -> info (M2)
	Providers   []*SyncProviderMeta        `json:"providers"`
	Conflict    *SyncConflictInfo          `json:"conflict"`
	LastSyncAt  *time.Time                 `json:"last_sync_at"`
}
