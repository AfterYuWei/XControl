// Package sync implements local backup versioning: version creation,
// FIFO retention, restore, and the trigger scheduler (M1). Cloud provider
// integration arrives in M2 behind the Provider interface.
package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

var (
	ErrPasswordRequired = errors.New("请先在同步设置中配置同步密码")
	ErrSyncing          = errors.New("同步操作进行中，请稍后")
	ErrConflict         = errors.New("存在待解决的版本冲突")
)

// Manager coordinates version creation, retention and restore.
type Manager struct {
	mu          sync.Mutex // guards status transitions
	backups     *store.BackupStore
	versions    *store.SyncStore
	providers   *store.SyncProviderStore
	backupDir   string
	deviceID    string
	scheduler   *Scheduler
	changeCh    chan struct{} // receives data-change notifications
}

func NewManager(backups *store.BackupStore, versions *store.SyncStore, providers *store.SyncProviderStore, backupDir string) (*Manager, error) {
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return nil, fmt.Errorf("create backup dir: %w", err)
	}
	m := &Manager{
		backups:   backups,
		versions:  versions,
		providers: providers,
		backupDir: backupDir,
		deviceID:  uuid.NewString(),
		changeCh:  make(chan struct{}, 1),
	}
	m.scheduler = newScheduler(m)
	return m, nil
}

// Start launches the scheduler loop; Stop shuts it down.
func (m *Manager) Start(ctx context.Context) { m.scheduler.Run(ctx) }
func (m *Manager) Stop()                     { m.scheduler.Stop() }

// ReloadSettings reschedules timers after settings change.
func (m *Manager) ReloadSettings() { m.scheduler.Reload() }

// NotifyChange signals that business data changed (called by the HTTP
// middleware). Non-blocking; the scheduler debounces bursts.
func (m *Manager) NotifyChange() {
	select {
	case m.changeCh <- struct{}{}:
	default:
	}
}

func (m *Manager) settings() (*model.SyncSettings, error) { return m.versions.LoadSettings() }

// GetSettings returns current settings (password never included).
func (m *Manager) GetSettings() (*model.SyncSettings, error) {
	st, err := m.settings()
	if err != nil {
		return nil, err
	}
	st.SyncPassword = ""
	return st, nil
}

// SaveSettings persists settings and reschedules timers.
func (m *Manager) SaveSettings(st *model.SyncSettings) error {
	if err := m.versions.SaveSettings(st); err != nil {
		return err
	}
	m.ReloadSettings()
	return nil
}

// Status builds the status-card payload.
func (m *Manager) Status() (*model.SyncStatusResponse, error) {
	status, lastSync, conflictJSON, err := m.versions.GetState()
	if err != nil {
		return nil, err
	}
	resp := &model.SyncStatusResponse{
		Status:      status,
		CloudLatest: map[string]model.SyncVersionInfo{},
		Providers:   []*model.SyncProviderMeta{},
		LastSyncAt:  lastSync,
	}
	if latest, err := m.versions.LatestVersion(); err == nil && latest != nil {
		info := latest.Info()
		resp.LocalLatest = &info
	}
	if conflictJSON != "" {
		var c model.SyncConflictInfo
		if json.Unmarshal([]byte(conflictJSON), &c) == nil {
			resp.Conflict = &c
		}
	}
	if rows, err := m.providers.List(); err == nil {
		for _, r := range rows {
			meta := r.Meta
			resp.Providers = append(resp.Providers, &meta)
		}
	}
	// Best-effort cloud version probe (short timeout, failures ignored).
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp.CloudLatest = m.CloudLatest(ctx)
	return resp, nil
}

// ListVersions exposes local version history.
func (m *Manager) ListVersions() ([]*model.SyncVersion, error) {
	return m.versions.ListVersions()
}

// ListEvents exposes recent sync activity (errors included).
func (m *Manager) ListEvents(limit int) ([]*model.SyncEvent, error) {
	return m.versions.ListEvents(limit)
}

// CreateVersion builds an encrypted backup of the current DB and registers
// it as a new local version. Returns (nil, nil) when nothing changed since
// the latest version (identical content hash).
func (m *Manager) CreateVersion(ctx context.Context, origin string) (*model.SyncVersion, error) {
	settings, err := m.settings()
	if err != nil {
		return nil, err
	}
	if settings.SyncPassword == "" {
		return nil, ErrPasswordRequired
	}

	data, payloadHash, err := buildEncryptedBackup(m.backups, settings.SyncPassword)
	if err != nil {
		return nil, err
	}
	// Dedup by business-content hash (stable across exports of identical
	// data), not by file bytes (KDF salt / exported_at make every file unique).
	hash := payloadHash

	if latest, err := m.versions.LatestVersion(); err != nil {
		return nil, err
	} else if latest != nil && latest.Hash == hash {
		return nil, nil // content unchanged — skip
	}

	if !m.mu.TryLock() {
		return nil, ErrSyncing
	}
	defer m.mu.Unlock()

	num, err := m.versions.NextVersion()
	if err != nil {
		return nil, err
	}
	filename := fmt.Sprintf("v%06d-%s.xcbackup", num, hash[:12])
	path := filepath.Join(m.backupDir, filename)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return nil, fmt.Errorf("write version file: %w", err)
	}

	v := &model.SyncVersion{
		ID:        uuid.NewString(),
		Version:   num,
		Hash:      hash,
		Size:      int64(len(data)),
		FilePath:  path,
		Origin:    origin,
		SyncedTo:  []string{},
		CreatedAt: time.Now(),
	}
	if err := m.versions.AddVersion(v); err != nil {
		os.Remove(path)
		return nil, err
	}
	m.versions.LogEvent("", "backup", num, true, "")
	m.versions.TouchLastSync()

	// Push to clouds asynchronously (failures logged as events, retried on
	// the next sync cycle) so backup latency stays local-only.
	go m.PushLatest(context.Background())

	// FIFO retention after every successful version.
	if err := m.enforceRetention(settings); err != nil {
		slog.Warn("sync retention failed", "error", err)
	}
	return v, nil
}

// enforceRetention deletes oldest local versions beyond the keep limit.
// Versions never pushed anywhere (SyncedTo empty) are preserved — deleting
// the only copy of data is never acceptable.
func (m *Manager) enforceRetention(settings *model.SyncSettings) error {
	keep := settings.LocalKeepVersions
	if keep <= 0 {
		return nil
	}
	versions, err := m.versions.ListVersions() // newest first
	if err != nil {
		return err
	}
	if len(versions) <= keep {
		return nil
	}
	for _, v := range versions[keep:] {
		if len(v.SyncedTo) == 0 {
			// Never delete the only copy of data: versions not yet pushed
			// anywhere are preserved regardless of the keep limit.
			continue
		}
		m.deleteFromClouds(context.Background(), v) // no-op unless mirror_local
		if err := os.Remove(v.FilePath); err != nil && !os.IsNotExist(err) {
			slog.Warn("remove version file failed", "path", v.FilePath, "error", err)
			continue
		}
		if err := m.versions.DeleteVersion(v.ID); err != nil {
			return err
		}
		m.versions.LogEvent("", "delete", v.Version, true, "retention fifo")
	}
	return nil
}

// DeleteVersion removes one local version (user-initiated). The same
// unsynced-protection applies unless force is set.
func (m *Manager) DeleteVersion(id string, force bool) error {
	v, err := m.versions.GetVersion(id)
	if err != nil {
		return err
	}
	if !force && len(v.SyncedTo) == 0 {
		return errors.New("该版本尚未同步到任何云端，删除后将无法恢复（可用 force 强制删除）")
	}
	m.deleteFromClouds(context.Background(), v) // no-op unless mirror_local
	if err := os.Remove(v.FilePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	m.versions.LogEvent("", "delete", v.Version, true, "user")
	return m.versions.DeleteVersion(id)
}

// RestoreVersion replaces current business data with a version's content.
// Hash is verified before import; the restore itself creates a new version
// so the operation is always reversible.
func (m *Manager) RestoreVersion(ctx context.Context, id string) (*model.SyncVersion, error) {
	settings, err := m.settings()
	if err != nil {
		return nil, err
	}
	v, err := m.versions.GetVersion(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(v.FilePath)
	if err != nil {
		return nil, fmt.Errorf("读取版本文件失败: %w", err)
	}

	parsed, payloadHash, err := handlerDecode(data, settings.SyncPassword)
	if err != nil {
		return nil, err
	}
	// v.Hash is the business-payload hash recorded at creation time.
	if payloadHash != v.Hash {
		return nil, fmt.Errorf("版本文件校验失败（内容 hash 不匹配），文件可能已损坏或同步密码已变更")
	}
	if _, err := m.backups.Import(parsed, model.BackupStrategyOverwrite); err != nil {
		return nil, fmt.Errorf("恢复数据失败: %w", err)
	}
	m.versions.LogEvent("", "restore", v.Version, true, "")

	// Record the restore itself as a new version (hash unchanged → skipped,
	// which is fine: content equals the restored version already).
	return m.CreateVersion(ctx, model.SyncOriginRestore)
}

// ShutdownBackup performs the exit-trigger backup with a bounded timeout.
func (m *Manager) ShutdownBackup() {
	settings, err := m.settings()
	if err != nil || !settings.AutoBackupEnabled {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := m.CreateVersion(ctx, model.SyncOriginShutdown); err != nil && !errors.Is(err, ErrPasswordRequired) {
		slog.Warn("shutdown backup failed", "error", err)
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

// buildEncryptedBackup exports business data and encrypts it with the sync
// password (same .xcbackup format as manual export). Returns the file bytes
// plus a stable SHA-256 of the business payload (for change detection).
func buildEncryptedBackup(backups *store.BackupStore, password string) ([]byte, string, error) {
	payload, err := backups.Export()
	if err != nil {
		return nil, "", err
	}
	kdf, err := crypto.NewKDFParams()
	if err != nil {
		return nil, "", err
	}
	key, err := crypto.DeriveKeyArgon2id(password, kdf)
	if err != nil {
		return nil, "", err
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(plaintext)
	payloadHash := hex.EncodeToString(sum[:])

	aad := []byte(fmt.Sprintf("%s:%d", model.BackupFormat, model.BackupVersion))
	enc, err := crypto.EncryptWithKey(key, plaintext, aad)
	if err != nil {
		return nil, "", err
	}
	file := &model.BackupFile{
		Format:         model.BackupFormat,
		Version:        model.BackupVersion,
		ExportedAt:     time.Now().UTC(),
		CredentialMode: model.BackupCredEncrypted,
		KDF:            kdf,
		Payload:        enc,
	}
	data, err := json.Marshal(file)
	return data, payloadHash, err
}

// handlerDecode decrypts an encrypted .xcbackup file back into a payload,
// returning the payload hash used for integrity verification.
func handlerDecode(data []byte, password string) (*model.BackupPayload, string, error) {
	var file model.BackupFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, "", fmt.Errorf("版本文件格式无效: %w", err)
	}
	if file.CredentialMode != model.BackupCredEncrypted || file.KDF == nil {
		return nil, "", fmt.Errorf("版本文件不是加密备份")
	}
	key, err := crypto.DeriveKeyArgon2id(password, file.KDF)
	if err != nil {
		return nil, "", err
	}
	aad := []byte(fmt.Sprintf("%s:%d", model.BackupFormat, model.BackupVersion))
	plaintext, err := crypto.DecryptWithKey(key, aad, file.Payload)
	if err != nil {
		return nil, "", fmt.Errorf("版本文件解密失败（同步密码可能已变更）: %w", err)
	}
	sum := sha256.Sum256(plaintext)
	payloadHash := hex.EncodeToString(sum[:])
	var payload model.BackupPayload
	if err := json.NewDecoder(bytes.NewReader(plaintext)).Decode(&payload); err != nil {
		return nil, "", fmt.Errorf("版本内容损坏: %w", err)
	}
	return &payload, payloadHash, nil
}
