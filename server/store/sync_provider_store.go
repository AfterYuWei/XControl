package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

// SyncProviderStore persists cloud provider configs with AES-encrypted
// credentials (same encryptor that protects the vault).
type SyncProviderStore struct {
	db        *sql.DB
	encryptor *crypto.Encryptor
}

func NewSyncProviderStore(db *sql.DB, encryptor *crypto.Encryptor) *SyncProviderStore {
	return &SyncProviderStore{db: db, encryptor: encryptor}
}

// providerRow is one decrypted provider record.
type ProviderRow struct {
	Meta   model.SyncProviderMeta
	Config model.SyncProviderConfig
}

func (s *SyncProviderStore) Create(cfg *model.SyncProviderConfig) (*ProviderRow, error) {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	enc, err := s.encryptor.Encrypt(string(raw))
	if err != nil {
		return nil, fmt.Errorf("加密配置失败: %w", err)
	}
	now := time.Now()
	row := &ProviderRow{
		Meta: model.SyncProviderMeta{
			ID:        uuid.NewString(),
			Type:      cfg.Type,
			Name:      cfg.Name,
			Enabled:   cfg.Enabled,
			CreatedAt: now,
			UpdatedAt: now,
		},
		Config: *cfg,
	}
	_, err = s.db.Exec(
		`INSERT INTO sync_providers (id, type, name, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		row.Meta.ID, cfg.Type, cfg.Name, boolToInt(cfg.Enabled), enc, now, now,
	)
	if err != nil {
		return nil, err
	}
	return row, nil
}

func (s *SyncProviderStore) scan(row interface{ Scan(...any) error }) (*ProviderRow, error) {
	var (
		meta    model.SyncProviderMeta
		encCfg  string
		enabled int
	)
	err := row.Scan(&meta.ID, &meta.Type, &meta.Name, &enabled, &encCfg, &meta.CreatedAt, &meta.UpdatedAt)
	if err != nil {
		return nil, err
	}
	meta.Enabled = enabled == 1
	plain, err := s.encryptor.Decrypt(encCfg)
	if err != nil {
		return nil, fmt.Errorf("解密配置失败: %w", err)
	}
	var cfg model.SyncProviderConfig
	if err := json.Unmarshal([]byte(plain), &cfg); err != nil {
		return nil, fmt.Errorf("配置数据损坏: %w", err)
	}
	return &ProviderRow{Meta: meta, Config: cfg}, nil
}

const providerCols = `id, type, name, enabled, config, created_at, updated_at`

func (s *SyncProviderStore) Get(id string) (*ProviderRow, error) {
	return s.scan(s.db.QueryRow(`SELECT `+providerCols+` FROM sync_providers WHERE id = ?`, id))
}

func (s *SyncProviderStore) List() ([]*ProviderRow, error) {
	rows, err := s.db.Query(`SELECT ` + providerCols + ` FROM sync_providers ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*ProviderRow, 0)
	for rows.Next() {
		row, err := s.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ListEnabled returns only enabled providers.
func (s *SyncProviderStore) ListEnabled() ([]*ProviderRow, error) {
	rows, err := s.db.Query(`SELECT ` + providerCols + ` FROM sync_providers WHERE enabled = 1 ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*ProviderRow, 0)
	for rows.Next() {
		row, err := s.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Update applies new config; empty secret fields keep existing values.
func (s *SyncProviderStore) Update(id string, cfg *model.SyncProviderConfig) error {
	existing, err := s.Get(id)
	if err != nil {
		return err
	}
	merged := mergeSecrets(&existing.Config, cfg)
	raw, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	enc, err := s.encryptor.Encrypt(string(raw))
	if err != nil {
		return fmt.Errorf("加密配置失败: %w", err)
	}
	_, err = s.db.Exec(
		`UPDATE sync_providers SET type = ?, name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?`,
		merged.Type, merged.Name, boolToInt(merged.Enabled), enc, time.Now(), id,
	)
	return err
}

// mergeSecrets keeps existing secrets when the update leaves them blank
// (the UI never round-trips secrets). OAuth tokens are always preserved —
// re-authorization is the only flow allowed to change them.
func mergeSecrets(old, new *model.SyncProviderConfig) *model.SyncProviderConfig {
	out := *new
	if out.Password == "" {
		out.Password = old.Password
	}
	if out.S3SecretKey == "" {
		out.S3SecretKey = old.S3SecretKey
	}
	if out.OAuthClientSecret == "" {
		out.OAuthClientSecret = old.OAuthClientSecret
	}
	out.OAuthAccessToken = old.OAuthAccessToken
	out.OAuthRefreshToken = old.OAuthRefreshToken
	out.OAuthExpiry = old.OAuthExpiry
	if out.DriveFolderID == "" {
		out.DriveFolderID = old.DriveFolderID
	}
	if out.OneDriveFolder == "" {
		out.OneDriveFolder = old.OneDriveFolder
	}
	return &out
}

// SaveConfig writes a full config (used by the OAuth flow to persist tokens).
func (s *SyncProviderStore) SaveConfig(id string, cfg *model.SyncProviderConfig) error {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	enc, err := s.encryptor.Encrypt(string(raw))
	if err != nil {
		return fmt.Errorf("加密配置失败: %w", err)
	}
	_, err = s.db.Exec(`UPDATE sync_providers SET config = ?, updated_at = ? WHERE id = ?`, enc, time.Now(), id)
	return err
}

func (s *SyncProviderStore) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM sync_providers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("provider not found")
	}
	return nil
}
