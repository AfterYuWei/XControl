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

// SyncStore persists sync versions, settings, state and events.
// Cloud provider config CRUD lands with the M2 iteration.
type SyncStore struct {
	db        *sql.DB
	encryptor *crypto.Encryptor
}

func NewSyncStore(db *sql.DB, encryptor *crypto.Encryptor) *SyncStore {
	return &SyncStore{db: db, encryptor: encryptor}
}

// ── Versions ────────────────────────────────────────────────────────────────

// NextVersion atomically allocates the next global version number.
func (s *SyncStore) NextVersion() (int64, error) {
	var v int64
	err := s.db.QueryRow(
		`UPDATE sync_state SET next_version = next_version + 1 WHERE id = 1 RETURNING next_version - 1`,
	).Scan(&v)
	return v, err
}

func (s *SyncStore) AddVersion(v *model.SyncVersion) error {
	synced, _ := json.Marshal(v.SyncedTo)
	_, err := s.db.Exec(
		`INSERT INTO sync_versions (id, version, hash, size, file_path, origin, synced_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.Version, v.Hash, v.Size, v.FilePath, v.Origin, string(synced), v.CreatedAt,
	)
	return err
}

func (s *SyncStore) scanVersion(row interface{ Scan(...any) error }) (*model.SyncVersion, error) {
	v := &model.SyncVersion{}
	var synced string
	err := row.Scan(&v.ID, &v.Version, &v.Hash, &v.Size, &v.FilePath, &v.Origin, &synced, &v.CreatedAt)
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(synced), &v.SyncedTo)
	if v.SyncedTo == nil {
		v.SyncedTo = []string{}
	}
	return v, nil
}

const versionCols = `id, version, hash, size, file_path, origin, synced_to, created_at`

func (s *SyncStore) LatestVersion() (*model.SyncVersion, error) {
	v, err := s.scanVersion(s.db.QueryRow(`SELECT `+versionCols+` FROM sync_versions ORDER BY version DESC LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return v, err
}

func (s *SyncStore) GetVersion(id string) (*model.SyncVersion, error) {
	return s.scanVersion(s.db.QueryRow(`SELECT `+versionCols+` FROM sync_versions WHERE id = ?`, id))
}

// ListVersions returns all versions, newest first.
func (s *SyncStore) ListVersions() ([]*model.SyncVersion, error) {
	rows, err := s.db.Query(`SELECT ` + versionCols + ` FROM sync_versions ORDER BY version DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*model.SyncVersion, 0)
	for rows.Next() {
		v, err := s.scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *SyncStore) DeleteVersion(id string) error {
	_, err := s.db.Exec(`DELETE FROM sync_versions WHERE id = ?`, id)
	return err
}

// UpsertVersion inserts a version, or updates the row when the version
// number already exists (used when pulling a cloud version whose number
// collides with a local row).
func (s *SyncStore) UpsertVersion(v *model.SyncVersion) error {
	synced, _ := json.Marshal(v.SyncedTo)
	_, err := s.db.Exec(
		`INSERT INTO sync_versions (id, version, hash, size, file_path, origin, synced_to, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(version) DO UPDATE SET
		   id = excluded.id, hash = excluded.hash, size = excluded.size,
		   file_path = excluded.file_path, origin = excluded.origin,
		   synced_to = excluded.synced_to, created_at = excluded.created_at`,
		v.ID, v.Version, v.Hash, v.Size, v.FilePath, v.Origin, string(synced), v.CreatedAt,
	)
	return err
}

// MarkSynced adds a provider id to a version's synced_to list (idempotent).
func (s *SyncStore) MarkSynced(versionID, providerID string) error {
	v, err := s.GetVersion(versionID)
	if err != nil {
		return err
	}
	for _, id := range v.SyncedTo {
		if id == providerID {
			return nil
		}
	}
	v.SyncedTo = append(v.SyncedTo, providerID)
	raw, _ := json.Marshal(v.SyncedTo)
	_, err = s.db.Exec(`UPDATE sync_versions SET synced_to = ? WHERE id = ?`, string(raw), versionID)
	return err
}

// EnsureNextVersion raises the version counter when a pulled cloud version
// is ahead, keeping future allocations monotonic across devices.
func (s *SyncStore) EnsureNextVersion(minNext int64) error {
	_, err := s.db.Exec(`UPDATE sync_state SET next_version = MAX(next_version, ?) WHERE id = 1`, minNext)
	return err
}

// ── State ───────────────────────────────────────────────────────────────────

func (s *SyncStore) GetState() (status string, lastSyncAt *time.Time, conflictJSON string, err error) {
	var ts sql.NullTime
	err = s.db.QueryRow(`SELECT status, last_sync_at, conflict_json FROM sync_state WHERE id = 1`).
		Scan(&status, &ts, &conflictJSON)
	if ts.Valid {
		lastSyncAt = &ts.Time
	}
	return
}

func (s *SyncStore) SetStatus(status string) error {
	_, err := s.db.Exec(`UPDATE sync_state SET status = ? WHERE id = 1`, status)
	return err
}

func (s *SyncStore) SetConflict(c *model.SyncConflictInfo) error {
	raw := ""
	if c != nil {
		b, err := json.Marshal(c)
		if err != nil {
			return err
		}
		raw = string(b)
	}
	status := model.SyncStatusIdle
	if c != nil {
		status = model.SyncStatusConflict
	}
	_, err := s.db.Exec(`UPDATE sync_state SET conflict_json = ?, status = ? WHERE id = 1`, raw, status)
	return err
}

func (s *SyncStore) TouchLastSync() error {
	_, err := s.db.Exec(`UPDATE sync_state SET last_sync_at = ? WHERE id = 1`, time.Now())
	return err
}

// ── Settings ────────────────────────────────────────────────────────────────

func (s *SyncStore) LoadSettings() (*model.SyncSettings, error) {
	settings := model.DefaultSyncSettings()
	rows, err := s.db.Query(`SELECT key, value FROM sync_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	kv := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		kv[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	get := func(k string) string { return kv[k] }
	boolv := func(k string, def bool) bool {
		if v, ok := kv[k]; ok {
			return v == "1"
		}
		return def
	}
	intv := func(k string, def int) int {
		if v, ok := kv[k]; ok {
			var n int
			if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
				return n
			}
		}
		return def
	}

	if v := get("sync_mode"); v != "" {
		settings.SyncMode = v
	}
	if v := get("conflict_policy"); v != "" {
		settings.ConflictPolicy = v
	}
	if v := get("cloud_retention"); v != "" {
		settings.CloudRetention = v
	}
	settings.LocalKeepVersions = intv("local_keep_versions", settings.LocalKeepVersions)
	settings.ScheduledEnabled = boolv("scheduled_enabled", false)
	settings.ScheduledIntervalHrs = intv("scheduled_interval_hours", 0)
	settings.ScheduledDailyTime = get("scheduled_daily_time")
	settings.AutoBackupEnabled = boolv("auto_backup_enabled", false)
	settings.ChangeDebounceSeconds = intv("change_debounce_seconds", settings.ChangeDebounceSeconds)

	if encPwd, ok := kv["sync_password"]; ok && encPwd != "" {
		settings.SyncPasswordSet = true
		if pwd, err := s.encryptor.Decrypt(encPwd); err == nil {
			settings.SyncPassword = pwd
		}
	}
	return settings, nil
}

// SaveSettings persists every field; sync_password is AES-encrypted at rest.
func (s *SyncStore) SaveSettings(st *model.SyncSettings) error {
	upsert := func(k, v string) error {
		_, err := s.db.Exec(
			`INSERT INTO sync_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			k, v,
		)
		return err
	}
	b := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}

	for _, kv := range [][2]string{
		{"sync_mode", st.SyncMode},
		{"conflict_policy", st.ConflictPolicy},
		{"cloud_retention", st.CloudRetention},
		{"local_keep_versions", fmt.Sprintf("%d", st.LocalKeepVersions)},
		{"scheduled_enabled", b(st.ScheduledEnabled)},
		{"scheduled_interval_hours", fmt.Sprintf("%d", st.ScheduledIntervalHrs)},
		{"scheduled_daily_time", st.ScheduledDailyTime},
		{"auto_backup_enabled", b(st.AutoBackupEnabled)},
		{"change_debounce_seconds", fmt.Sprintf("%d", st.ChangeDebounceSeconds)},
	} {
		if err := upsert(kv[0], kv[1]); err != nil {
			return err
		}
	}

	if st.SyncPassword != "" {
		enc, err := s.encryptor.Encrypt(st.SyncPassword)
		if err != nil {
			return fmt.Errorf("encrypt sync password: %w", err)
		}
		if err := upsert("sync_password", enc); err != nil {
			return err
		}
	}
	return nil
}

// ── Events ──────────────────────────────────────────────────────────────────

func (s *SyncStore) LogEvent(providerID, action string, version int64, success bool, errMsg string) {
	e := &model.SyncEvent{
		ID:         uuid.NewString(),
		ProviderID: providerID,
		Action:     action,
		Version:    version,
		Success:    success,
		Error:      errMsg,
		CreatedAt:  time.Now(),
	}
	s.db.Exec(
		`INSERT INTO sync_events (id, provider_id, action, version, success, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.ProviderID, e.Action, e.Version, boolToInt(e.Success), e.Error, e.CreatedAt,
	)
}

func (s *SyncStore) ListEvents(limit int) ([]*model.SyncEvent, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(
		`SELECT id, provider_id, action, version, success, error, created_at FROM sync_events ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*model.SyncEvent, 0)
	for rows.Next() {
		e := &model.SyncEvent{}
		var success int
		if err := rows.Scan(&e.ID, &e.ProviderID, &e.Action, &e.Version, &success, &e.Error, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Success = success == 1
		out = append(out, e)
	}
	return out, rows.Err()
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
