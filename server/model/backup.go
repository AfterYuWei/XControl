package model

import (
	"time"

	"github.com/yuweinfo/xcontrol/crypto"
)

// Backup file format constants.
const (
	BackupFormat  = "xcontrol-backup"
	BackupVersion = 1

	// Credential modes of a backup file.
	BackupCredNone      = "none"      // no credentials, plain top-level data
	BackupCredEncrypted = "encrypted" // everything encrypted into payload
	BackupCredPlain     = "plain"     // credentials in plain top-level data
)

// Import merge strategies.
const (
	BackupStrategySkip       = "skip"       // keep existing records
	BackupStrategyOverwrite  = "overwrite"  // replace existing records
	BackupStrategyRegenerate = "regenerate" // assign new IDs, remap references
)

// BackupFile is the on-disk .xcbackup JSON document.
//
// Layout depends on CredentialMode:
//   - none / plain: Groups/Profiles/Vault/Snippets live at top level
//     (Vault empty and inline credentials stripped for "none").
//   - encrypted: only metadata at top level; Payload holds
//     AES-256-GCM(backupKey, BackupPayload JSON) as
//     Base64(Nonce ∥ Ciphertext ∥ AuthTag).
type BackupFile struct {
	Format         string             `json:"format"`
	Version        int                `json:"version"`
	ExportedAt     time.Time          `json:"exported_at"`
	CredentialMode string             `json:"credential_mode"`
	KDF            *crypto.KDFParams  `json:"kdf,omitempty"`
	Payload        string             `json:"payload,omitempty"`
	Groups         []*Group           `json:"groups,omitempty"`
	Vault          []*BackupVaultItem `json:"vault,omitempty"`
	Profiles       []*BackupProfile   `json:"profiles,omitempty"`
	Snippets       []*Snippet         `json:"snippets,omitempty"`
}

// BackupPayload is the decrypted content of an encrypted backup's Payload.
type BackupPayload struct {
	Groups   []*Group           `json:"groups"`
	Vault    []*BackupVaultItem `json:"vault"`
	Profiles []*BackupProfile   `json:"profiles"`
	Snippets []*Snippet         `json:"snippets"`
}

// BackupProfile mirrors Profile but carries the decrypted inline credential.
type BackupProfile struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Host             string          `json:"host"`
	Port             int             `json:"port"`
	Username         string          `json:"username"`
	AuthType         string          `json:"auth_type"`
	Icon             string          `json:"icon,omitempty"`
	VaultID          string          `json:"vault_id,omitempty"`
	InlineCredential *Credential     `json:"inline_credential,omitempty"`
	GroupID          string          `json:"group_id,omitempty"`
	Tags             []string        `json:"tags"`
	Options          string          `json:"options,omitempty"`
	Note             string          `json:"note,omitempty"`
	SortOrder        int             `json:"sort_order"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// BackupVaultItem mirrors a vault row with decrypted credential data.
type BackupVaultItem struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Type        string      `json:"type"`
	Username    string      `json:"username"`
	Remark      string      `json:"remark"`
	Fingerprint string      `json:"fingerprint"`
	Credential  *Credential `json:"credential"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

// BackupStats summarizes backup contents for preview/result responses.
type BackupStats struct {
	Groups   int `json:"groups"`
	Vault    int `json:"vault"`
	Profiles int `json:"profiles"`
	Snippets int `json:"snippets"`
}

// BackupPreviewResponse describes a parsed backup before import.
type BackupPreviewResponse struct {
	CredentialMode string      `json:"credential_mode"`
	ExportedAt     time.Time   `json:"exported_at"`
	Stats          BackupStats `json:"stats"`
	Conflicts      BackupStats `json:"conflicts"` // ids already present in DB
}

// BackupImportResult reports per-resource import outcome.
type BackupImportResult struct {
	Imported BackupStats `json:"imported"`
	Skipped  BackupStats `json:"skipped"`
}
