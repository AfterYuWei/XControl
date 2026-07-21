package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync"
)

type SyncHandler struct {
	mgr *sync.Manager
}

func NewSyncHandler(mgr *sync.Manager) *SyncHandler {
	return &SyncHandler{mgr: mgr}
}

// Status handles GET /api/sync/status
func (h *SyncHandler) Status(w http.ResponseWriter, r *http.Request) {
	status, err := h.mgr.Status()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STATUS_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// BackupNow handles POST /api/sync/backup — creates a local version
// immediately (origin=manual).
func (h *SyncHandler) BackupNow(w http.ResponseWriter, r *http.Request) {
	v, err := h.mgr.CreateVersion(r.Context(), model.SyncOriginManual)
	if err != nil {
		h.writeSyncError(w, err)
		return
	}
	if v == nil {
		writeJSON(w, http.StatusOK, map[string]any{"created": false, "message": "数据自上一版本以来没有变化"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"created": true, "version": v})
}

// Versions handles GET /api/sync/versions
func (h *SyncHandler) Versions(w http.ResponseWriter, r *http.Request) {
	versions, err := h.mgr.ListVersions()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

// RestoreVersion handles POST /api/sync/versions/{id}/restore
func (h *SyncHandler) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	v, err := h.mgr.RestoreVersion(r.Context(), r.PathValue("id"))
	if err != nil {
		h.writeSyncError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"restored": true, "version": v})
}

// DeleteVersion handles DELETE /api/sync/versions/{id}?force=1
func (h *SyncHandler) DeleteVersion(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("force") == "1" || r.URL.Query().Get("force") == "true"
	if err := h.mgr.DeleteVersion(r.PathValue("id"), force); err != nil {
		writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Events handles GET /api/sync/events?limit=50
func (h *SyncHandler) Events(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := h.mgr.ListEvents(limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, events)
}

// GetSettings handles GET /api/sync/settings
func (h *SyncHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.mgr.GetSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// UpdateSettings handles PUT /api/sync/settings. Body is a full settings
// object plus optional sync_password (empty = keep current).
func (h *SyncHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		model.SyncSettings
		SyncPassword string `json:"sync_password,omitempty"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_BODY", "请求体格式错误")
		return
	}
	req := body.SyncSettings
	req.SyncPassword = body.SyncPassword
	if err := validateSyncSettings(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_SETTINGS", err.Error())
		return
	}
	if err := h.mgr.SaveSettings(&req); err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

// ShutdownTrigger handles POST /api/sync/shutdown — the beforeunload hook
// fires this via sendBeacon when auto backup is enabled.
func (h *SyncHandler) ShutdownTrigger(w http.ResponseWriter, r *http.Request) {
	go h.mgr.ShutdownBackup()
	w.WriteHeader(http.StatusAccepted)
}

// ── Cloud sync (M2) ─────────────────────────────────────────────────────────

// SyncNow handles POST /api/sync/now — full bidirectional sync cycle.
func (h *SyncHandler) SyncNow(w http.ResponseWriter, r *http.Request) {
	go h.mgr.SyncAll(r.Context())
	writeJSON(w, http.StatusAccepted, map[string]bool{"started": true})
}

// Push handles POST /api/sync/push — push local latest to all providers.
func (h *SyncHandler) Push(w http.ResponseWriter, r *http.Request) {
	go h.mgr.PushLatest(r.Context())
	writeJSON(w, http.StatusAccepted, map[string]bool{"started": true})
}

// ResolveConflict handles POST /api/sync/resolve {"choice":"keep_local"|"use_cloud"}
func (h *SyncHandler) ResolveConflict(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Choice string `json:"choice"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_BODY", "请求体格式错误")
		return
	}
	if body.Choice != "keep_local" && body.Choice != "use_cloud" {
		writeError(w, http.StatusBadRequest, "INVALID_CHOICE", "choice 须为 keep_local | use_cloud")
		return
	}
	v, err := h.mgr.ResolveConflict(r.Context(), body.Choice)
	if err != nil {
		h.writeSyncError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"resolved": true, "version": v})
}

// ── Provider CRUD ───────────────────────────────────────────────────────────

// ListProviders handles GET /api/sync/providers
func (h *SyncHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := h.mgr.ListProviders()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, providers)
}

// CreateProvider handles POST /api/sync/providers
func (h *SyncHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var cfg model.SyncProviderConfig
	if err := decodeJSON(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_BODY", "请求体格式错误")
		return
	}
	meta, err := h.mgr.CreateProvider(&cfg)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PROVIDER", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, meta)
}

// UpdateProvider handles PUT /api/sync/providers/{id}
func (h *SyncHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	var cfg model.SyncProviderConfig
	if err := decodeJSON(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_BODY", "请求体格式错误")
		return
	}
	if err := h.mgr.UpdateProvider(r.PathValue("id"), &cfg); err != nil {
		writeError(w, http.StatusBadRequest, "UPDATE_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

// DeleteProvider handles DELETE /api/sync/providers/{id}
func (h *SyncHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	if err := h.mgr.DeleteProvider(r.PathValue("id")); err != nil {
		writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TestProvider handles POST /api/sync/providers/{id}/test
func (h *SyncHandler) TestProvider(w http.ResponseWriter, r *http.Request) {
	if err := h.mgr.TestProvider(r.Context(), r.PathValue("id")); err != nil {
		writeError(w, http.StatusBadRequest, "TEST_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── OAuth authorization (M3) ────────────────────────────────────────────────

// OAuthURL handles GET /api/sync/oauth/{type}/url?provider_id=xxx
// Returns the authorization URL the frontend opens in a browser window.
func (h *SyncHandler) OAuthURL(w http.ResponseWriter, r *http.Request) {
	providerType := r.PathValue("type")
	providerID := r.URL.Query().Get("provider_id")
	if providerID == "" {
		writeError(w, http.StatusBadRequest, "MISSING_PROVIDER", "缺少 provider_id")
		return
	}
	url, err := h.mgr.BuildOAuthURL(r.Context(), providerType, providerID, oauthRedirectURI(r, providerType))
	if err != nil {
		writeError(w, http.StatusBadRequest, "OAUTH_URL_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// OAuthCallback handles GET /api/sync/oauth/{type}/callback?code=...&state=...
// This endpoint is hit by the browser redirect after user consent.
func (h *SyncHandler) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	providerType := r.PathValue("type")
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		writeOAuthResult(w, false, "缺少 code 或 state 参数")
		return
	}
	if err := h.mgr.CompleteOAuth(r.Context(), providerType, state, code, oauthRedirectURI(r, providerType)); err != nil {
		writeOAuthResult(w, false, err.Error())
		return
	}
	writeOAuthResult(w, true, "")
}

// oauthRedirectURI derives the callback URL from the incoming request so it
// works behind the Vite dev proxy and in desktop packaging alike.
func oauthRedirectURI(r *http.Request, providerType string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
		scheme = fwd
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return fmt.Sprintf("%s://%s/api/sync/oauth/%s/callback", scheme, host, providerType)
}

// writeOAuthResult renders a minimal HTML page for the popup window.
func writeOAuthResult(w http.ResponseWriter, ok bool, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	title, body := "授权成功", "您可以关闭此窗口，返回应用继续操作。"
	if !ok {
		title, body = "授权失败", msg
	}
	fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>%s</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 12px}p{color:#666;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>%s</h1><p>%s</p></div></body></html>`, title, title, body)
}

func (h *SyncHandler) writeSyncError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sync.ErrPasswordRequired):
		writeError(w, http.StatusBadRequest, "SYNC_PASSWORD_REQUIRED", err.Error())
	case errors.Is(err, sync.ErrSyncing):
		writeError(w, http.StatusConflict, "SYNC_IN_PROGRESS", err.Error())
	case errors.Is(err, sync.ErrConflict):
		writeError(w, http.StatusConflict, "NO_CONFLICT", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "SYNC_FAILED", err.Error())
	}
}

func validateSyncSettings(s *model.SyncSettings) error {
	switch s.SyncMode {
	case "manual", "auto":
	default:
		return errors.New("sync_mode 须为 manual | auto")
	}
	switch s.ConflictPolicy {
	case "prompt", "latest":
	default:
		return errors.New("conflict_policy 须为 prompt | latest")
	}
	switch s.CloudRetention {
	case "keep_forever", "mirror_local":
	default:
		return errors.New("cloud_retention 须为 keep_forever | mirror_local")
	}
	if s.ScheduledDailyTime != "" {
		if len(s.ScheduledDailyTime) != 5 || s.ScheduledDailyTime[2] != ':' {
			return errors.New("scheduled_daily_time 格式须为 HH:MM")
		}
	}
	if s.ChangeDebounceSeconds < 5 {
		s.ChangeDebounceSeconds = 5
	}
	return nil
}
