package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
	"github.com/yuweinfo/xcontrol/sync/providers"
	"github.com/yuweinfo/xcontrol/store"
)

// ── provider.Provider instantiation ──────────────────────────────────────────────────

// buildProvider instantiates a provider.Provider from a decrypted config row.
func buildProvider(row *store.ProviderRow) (provider.Provider, error) {
	switch row.Config.Type {
	case "webdav":
		return providers.NewWebDAV(row.Meta.ID, &row.Config), nil
	case "s3":
		return providers.NewS3(row.Meta.ID, &row.Config)
	case "gdrive", "onedrive":
		return nil, fmt.Errorf("OAuth provider 需要通过 manager.buildOAuthProvider 构造")
	default:
		return nil, fmt.Errorf("暂不支持的云服务类型: %s", row.Config.Type)
	}
}

// buildOAuthProvider constructs gdrive/onedrive providers with token refresh
// and persistence wired to the provider store.
func (m *Manager) buildOAuthProvider(row *store.ProviderRow) (provider.Provider, error) {
	persist := func(mutate func(cfg *model.SyncProviderConfig)) error {
		fresh, err := m.providers.Get(row.Meta.ID)
		if err != nil {
			return err
		}
		mutate(&fresh.Config)
		return m.providers.SaveConfig(row.Meta.ID, &fresh.Config)
	}
	refresh := func(ctx context.Context) (string, error) {
		tok, err := RefreshTokens(ctx, row.Config.Type, &row.Config)
		if err != nil {
			return "", err
		}
		if err := persist(func(cfg *model.SyncProviderConfig) {
			cfg.OAuthAccessToken = tok.AccessToken
			cfg.OAuthRefreshToken = tok.RefreshToken
			cfg.OAuthExpiry = tok.Expiry
		}); err != nil {
			slog.Warn("persist refreshed oauth token failed", "provider", row.Meta.ID, "error", err)
		}
		return tok.AccessToken, nil
	}
	switch row.Config.Type {
	case "gdrive":
		return providers.NewGDrive(row.Meta.ID, &row.Config, refresh, persist), nil
	case "onedrive":
		return providers.NewOneDrive(row.Meta.ID, &row.Config, refresh, persist), nil
	default:
		return nil, fmt.Errorf("unsupported oauth provider: %s", row.Config.Type)
	}
}

// buildAnyProvider dispatches to the right constructor by config type.
func (m *Manager) buildAnyProvider(row *store.ProviderRow) (provider.Provider, error) {
	if row.Config.Type == "gdrive" || row.Config.Type == "onedrive" {
		return m.buildOAuthProvider(row)
	}
	return buildProvider(row)
}

// ── Cloud sync core ─────────────────────────────────────────────────────────

// SyncAll pushes the latest local version to every enabled provider,
// and (in auto mode) pulls when a provider is ahead. Each provider runs
// independently; failures are logged as events, never abort others.
func (m *Manager) SyncAll(ctx context.Context) {
	settings, err := m.settings()
	if err != nil {
		return
	}
	rows, err := m.providers.ListEnabled()
	if err != nil || len(rows) == 0 {
		return
	}

	m.versions.SetStatus(model.SyncStatusSyncing)
	defer m.versions.SetStatus(model.SyncStatusIdle)

	var wg sync.WaitGroup
	for _, row := range rows {
		wg.Add(1)
		go func(row *store.ProviderRow) {
			defer wg.Done()
			p, err := m.buildAnyProvider(row)
			if err != nil {
				m.versions.LogEvent(row.Meta.ID, "sync", 0, false, err.Error())
				return
			}
			if err := m.syncWithProvider(ctx, p, settings); err != nil {
				m.versions.LogEvent(row.Meta.ID, "sync", 0, false, err.Error())
				slog.Warn("cloud sync failed", "provider", row.Meta.Name, "error", err)
			}
		}(row)
	}
	wg.Wait()
	m.versions.TouchLastSync()
}

// PushLatest uploads the latest local version to all enabled providers.
// Used by manual "推送" and after every new version creation.
func (m *Manager) PushLatest(ctx context.Context) {
	latest, err := m.versions.LatestVersion()
	if err != nil || latest == nil {
		return
	}
	settings, err := m.settings()
	if err != nil {
		return
	}
	rows, err := m.providers.ListEnabled()
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	for _, row := range rows {
		wg.Add(1)
		go func(row *store.ProviderRow) {
			defer wg.Done()
			p, err := m.buildAnyProvider(row)
			if err != nil {
				m.versions.LogEvent(row.Meta.ID, "push", latest.Version, false, err.Error())
				return
			}
			if err := m.pushVersion(ctx, p, latest); err != nil {
				m.versions.LogEvent(row.Meta.ID, "push", latest.Version, false, err.Error())
			}
		}(row)
	}
	wg.Wait()
	m.versions.TouchLastSync()
	_ = settings
}

// syncWithProvider reconciles local state with one provider.
func (m *Manager) syncWithProvider(ctx context.Context, p provider.Provider, settings *model.SyncSettings) error {
	idx, err := p.ReadIndex(ctx)
	if err != nil {
		return err
	}
	local, err := m.versions.LatestVersion()
	if err != nil {
		return err
	}

	switch {
	case local == nil && idx.LatestVersion == 0:
		return nil // both empty

	case local == nil:
		// No local versions: adopt cloud in auto mode, otherwise wait.
		if settings.SyncMode == "auto" {
			return m.pullVersion(ctx, p, idx, idx.LatestVersion)
		}
		return nil

	case idx.LatestVersion < local.Version:
		// Local ahead → push.
		return m.pushVersion(ctx, p, local)

	case idx.LatestVersion > local.Version:
		// Cloud ahead. Forked? Local content must appear in cloud history.
		if idx.ContainsHash(local.Hash) {
			if settings.SyncMode == "auto" {
				return m.pullVersion(ctx, p, idx, idx.LatestVersion)
			}
			return nil // manual mode: wait for user action
		}
		return m.handleFork(ctx, p, idx, local, settings)

	default: // same version number
		if idx.HashOf(local.Version) == local.Hash {
			// identical: ensure local knows it is synced to this provider
			return m.markSynced(p, local, idx)
		}
		return m.handleFork(ctx, p, idx, local, settings)
	}
}

// handleFork resolves a diverged local/cloud state by policy.
func (m *Manager) handleFork(ctx context.Context, p provider.Provider, idx *provider.CloudIndex, local *model.SyncVersion, settings *model.SyncSettings) error {
	if settings.ConflictPolicy == "latest" {
		cloudV := idx.Latest()
		if cloudV != nil && cloudV.CreatedAt.After(local.CreatedAt) {
			return m.pullVersion(ctx, p, idx, cloudV.Version)
		}
		return m.pushVersion(ctx, p, local)
	}
	// prompt: record the conflict for the frontend to resolve.
	cloudV := idx.Latest()
	if cloudV == nil {
		return m.pushVersion(ctx, p, local)
	}
	return m.versions.SetConflict(&model.SyncConflictInfo{
		ProviderID:   p.ID(),
		ProviderName: p.Name(),
		Local:        local.Info(),
		Cloud: model.SyncVersionInfo{
			Version:   cloudV.Version,
			Hash:      cloudV.Hash,
			Size:      cloudV.Size,
			CreatedAt: cloudV.CreatedAt,
		},
	})
}

// ResolveConflict applies the user's choice: the winning side becomes the
// base for a NEW version (max+1) which is then pushed everywhere, so both
// sides converge.
func (m *Manager) ResolveConflict(ctx context.Context, choice string) (*model.SyncVersion, error) {
	_, _, conflictJSON, err := m.versions.GetState()
	if err != nil || conflictJSON == "" {
		return nil, ErrConflict
	}
	var c model.SyncConflictInfo
	if err := json.Unmarshal([]byte(conflictJSON), &c); err != nil {
		return nil, err
	}

	if choice == "use_cloud" {
		row, err := m.providers.Get(c.ProviderID)
		if err != nil {
			return nil, err
		}
		p, err := m.buildAnyProvider(row)
		if err != nil {
			return nil, err
		}
		idx, err := p.ReadIndex(ctx)
		if err != nil {
			return nil, err
		}
		if err := m.pullVersion(ctx, p, idx, c.Cloud.Version); err != nil {
			return nil, fmt.Errorf("拉取云端版本失败: %w", err)
		}
	}

	// Create the convergence version from current (possibly just-restored)
	// data, then push everywhere.
	v, err := m.CreateVersion(ctx, model.SyncOriginConflictResolve)
	if err != nil {
		return nil, err
	}
	if v == nil {
		// Content identical to latest local version; reuse it.
		v, _ = m.versions.LatestVersion()
	}
	if v != nil {
		m.PushLatest(ctx)
	}
	m.versions.SetConflict(nil)
	m.versions.LogEvent("", "resolve", vNum(v), true, choice)
	return v, nil
}

func vNum(v *model.SyncVersion) int64 {
	if v == nil {
		return 0
	}
	return v.Version
}

// ── push / pull primitives ──────────────────────────────────────────────────

// pushVersion uploads a local version file + updates the cloud index.
func (m *Manager) pushVersion(ctx context.Context, p provider.Provider, v *model.SyncVersion) error {
	f, err := os.Open(v.FilePath)
	if err != nil {
		return fmt.Errorf("打开版本文件失败: %w", err)
	}
	defer f.Close()

	obj := provider.ObjectName(v.Version, v.Hash)
	if err := p.PutObject(ctx, obj, f, v.Size); err != nil {
		return err
	}

	idx, err := p.ReadIndex(ctx)
	if err != nil {
		return err
	}
	idx.DeviceID = m.deviceID
	idx.Add(provider.CloudVersionInfo{
		Version:   v.Version,
		Hash:      v.Hash,
		Size:      v.Size,
		Object:    obj,
		CreatedAt: v.CreatedAt,
	})
	if err := p.WriteIndex(ctx, idx); err != nil {
		return err
	}

	if err := m.versions.MarkSynced(v.ID, p.ID()); err != nil {
		slog.Warn("mark synced failed", "error", err)
	}
	m.versions.LogEvent(p.ID(), "push", v.Version, true, "")
	return nil
}

// markSynced records a provider id on the local version when the cloud
// already holds identical content (no upload needed).
func (m *Manager) markSynced(p provider.Provider, v *model.SyncVersion, idx *provider.CloudIndex) error {
	return m.versions.MarkSynced(v.ID, p.ID())
}

// pullVersion downloads a cloud version into the local library and
// restores business data from it.
func (m *Manager) pullVersion(ctx context.Context, p provider.Provider, idx *provider.CloudIndex, version int64) error {
	var info *provider.CloudVersionInfo
	for i := range idx.Versions {
		if idx.Versions[i].Version == version {
			info = &idx.Versions[i]
			break
		}
	}
	if info == nil {
		return fmt.Errorf("云端索引中不存在版本 v%d", version)
	}

	rc, err := p.GetObject(ctx, info.Object)
	if err != nil {
		return err
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return fmt.Errorf("下载版本失败: %w", err)
	}

	settings, err := m.settings()
	if err != nil {
		return err
	}
	payload, payloadHash, err := handlerDecode(data, settings.SyncPassword)
	if err != nil {
		return err
	}
	if payloadHash != info.Hash {
		return fmt.Errorf("云端版本校验失败（hash 不匹配）")
	}

	// Register the version locally (keep the cloud's version number so both
	// sides converge on identical numbering).
	filename := fmt.Sprintf("v%06d-%s.xcbackup", info.Version, info.Hash[:12])
	path := filepath.Join(m.backupDir, filename)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("写入版本文件失败: %w", err)
	}

	// Restore business data.
	if _, err := m.backups.Import(payload, model.BackupStrategyOverwrite); err != nil {
		os.Remove(path)
		return fmt.Errorf("恢复数据失败: %w", err)
	}

	v := &model.SyncVersion{
		ID:        uuid.NewString(),
		Version:   info.Version,
		Hash:      info.Hash,
		Size:      int64(len(data)),
		FilePath:  path,
		Origin:    model.SyncOriginRestore,
		SyncedTo:  []string{p.ID()},
		CreatedAt: info.CreatedAt,
	}
	if err := m.versions.UpsertVersion(v); err != nil {
		return err
	}
	// Keep local numbering ahead of anything seen remotely.
	m.versions.EnsureNextVersion(info.Version + 1)
	m.versions.LogEvent(p.ID(), "pull", info.Version, true, "")
	return nil
}

// ── cloud retention ─────────────────────────────────────────────────────────

// deleteFromClouds removes a version object from providers (mirror_local).
func (m *Manager) deleteFromClouds(ctx context.Context, v *model.SyncVersion) {
	settings, err := m.settings()
	if err != nil || settings.CloudRetention != "mirror_local" {
		return
	}
	for _, providerID := range v.SyncedTo {
		row, err := m.providers.Get(providerID)
		if err != nil {
			continue
		}
		p, err := m.buildAnyProvider(row)
		if err != nil {
			continue
		}
		obj := provider.ObjectName(v.Version, v.Hash)
		if err := p.DeleteObject(ctx, obj); err != nil {
			m.versions.LogEvent(providerID, "delete", v.Version, false, err.Error())
			continue
		}
		if idx, err := p.ReadIndex(ctx); err == nil {
			idx.Remove(v.Version)
			if err := p.WriteIndex(ctx, idx); err != nil {
				m.versions.LogEvent(providerID, "delete", v.Version, false, err.Error())
				continue
			}
		}
		m.versions.LogEvent(providerID, "delete", v.Version, true, "mirror_local")
	}
}

// TestProvider verifies a provider config (before or after saving).
func (m *Manager) TestProvider(ctx context.Context, id string) error {
	row, err := m.providers.Get(id)
	if err != nil {
		return err
	}
	p, err := m.buildAnyProvider(row)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return p.Ping(ctx)
}

// ── provider CRUD passthrough ───────────────────────────────────────────────

func (m *Manager) ListProviders() ([]*model.SyncProviderMeta, error) {
	rows, err := m.providers.List()
	if err != nil {
		return nil, err
	}
	out := make([]*model.SyncProviderMeta, 0, len(rows))
	for _, r := range rows {
		meta := r.Meta
		if r.Config.Type == "gdrive" || r.Config.Type == "onedrive" {
			meta.Authorized = r.Config.Authorized()
		}
		out = append(out, &meta)
	}
	return out, nil
}

func (m *Manager) CreateProvider(cfg *model.SyncProviderConfig) (*model.SyncProviderMeta, error) {
	if err := validateProviderConfig(cfg); err != nil {
		return nil, err
	}
	row, err := m.providers.Create(cfg)
	if err != nil {
		return nil, err
	}
	return &row.Meta, nil
}

func (m *Manager) UpdateProvider(id string, cfg *model.SyncProviderConfig) error {
	if err := validateProviderConfig(cfg); err != nil {
		return err
	}
	return m.providers.Update(id, cfg)
}

func (m *Manager) DeleteProvider(id string) error {
	return m.providers.Delete(id)
}

func validateProviderConfig(cfg *model.SyncProviderConfig) error {
	if cfg.Name == "" {
		return fmt.Errorf("名称不能为空")
	}
	switch cfg.Type {
	case "webdav":
		if cfg.Endpoint == "" {
			return fmt.Errorf("WebDAV 地址不能为空")
		}
	case "s3":
		if cfg.S3Bucket == "" || cfg.S3AccessKey == "" {
			return fmt.Errorf("S3 Bucket 与 AccessKey 不能为空")
		}
	case "gdrive", "onedrive":
		if cfg.OAuthClientID == "" {
			return fmt.Errorf("OAuth Client ID 不能为空（需在对应云平台注册应用获取）")
		}
	default:
		return fmt.Errorf("暂不支持的云服务类型: %s", cfg.Type)
	}
	return nil
}

// CloudLatest returns each provider's latest cloud version for status cards.
func (m *Manager) CloudLatest(ctx context.Context) map[string]model.SyncVersionInfo {
	out := map[string]model.SyncVersionInfo{}
	rows, err := m.providers.ListEnabled()
	if err != nil {
		return out
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, row := range rows {
		wg.Add(1)
		go func(row *store.ProviderRow) {
			defer wg.Done()
			p, err := m.buildAnyProvider(row)
			if err != nil {
				return
			}
			cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			idx, err := p.ReadIndex(cctx)
			if err != nil {
				return
			}
			if latest := idx.Latest(); latest != nil {
				mu.Lock()
				out[row.Meta.ID] = model.SyncVersionInfo{
					Version:   latest.Version,
					Hash:      latest.Hash,
					Size:      latest.Size,
					CreatedAt: latest.CreatedAt,
				}
				mu.Unlock()
			}
		}(row)
	}
	wg.Wait()
	return out
}


