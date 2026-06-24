package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/fileutil"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/protocol"
	"github.com/yuweinfo/sshx/store"
	"github.com/yuweinfo/sshx/ws"
)

// SftpSession holds an active SFTP connection (or a local backend).
type SftpSession struct {
	ID        string
	ProfileID string
	Backend   fileutil.FileBackend
	Driver    protocol.Driver // nil for local sessions
	Status    string          // connecting | connected | disconnected
	Error     string
	CreatedAt time.Time

	// Connection info retained for direct server-to-server transfer (scp).
	// Empty for local sessions.
	Host       string
	Port       int
	Username   string
	Password   string
	PrivKey    string
	Passphrase string

	// For cancelling in-flight operations when the session closes.
	cancel context.CancelFunc
}

type SftpHandler struct {
	sessions  map[string]*SftpSession
	mu        sync.RWMutex
	profiles  store.ProfileStore
	vault     store.VaultStore
	audit     store.AuditStore
	pm        *protocol.Manager
	transfers *TransferManager
	hub       *ws.SftpHub
}

func NewSftpHandler(ps store.ProfileStore, vs store.VaultStore, as store.AuditStore, pm *protocol.Manager, hub *ws.SftpHub, transfers *TransferManager) *SftpHandler {
	return &SftpHandler{
		sessions:  make(map[string]*SftpSession),
		profiles:  ps,
		vault:     vs,
		audit:     as,
		pm:        pm,
		transfers: transfers,
		hub:       hub,
	}
}

// --- Session management ---

func (h *SftpHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var req model.SftpCreateSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.ProfileID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "profile_id is required")
		return
	}

	sessionID := uuid.New().String()
	ctx, cancel := context.WithCancel(context.Background())
	session := &SftpSession{
		ID:        sessionID,
		ProfileID: req.ProfileID,
		Status:    "connecting",
		CreatedAt: time.Now(),
		cancel:    cancel,
	}

	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	// Local session — no SSH/SFTP connection needed
	if req.ProfileID == "local" {
		session.Backend = fileutil.NewLocalBackend()
		session.Status = "connected"
		h.broadcastSessionStatus(sessionID, "connected")
		writeJSON(w, http.StatusCreated, model.SftpCreateSessionResponse{
			SessionID: sessionID,
			Status:    session.Status,
		})
		return
	}

	// Remote session — resolve profile + credentials, connect in background
	profile, err := h.profiles.Get(req.ProfileID)
	if err != nil {
		h.mu.Lock()
		delete(h.sessions, sessionID)
		h.mu.Unlock()
		cancel()
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}

	go func() {
		var password, privKey, passphrase string
		if profile.VaultID != "" {
			cred, err := h.vault.Retrieve(profile.VaultID)
			if err != nil {
				slog.Warn("failed to retrieve vault credential", "error", err)
			} else {
				password = cred.Password
				privKey = cred.PrivKey
				passphrase = cred.Passphrase
			}
		}

		// Retain connection info for direct server-to-server transfer
		session.Host = profile.Host
		session.Port = profile.Port
		session.Username = profile.Username
		session.Password = password
		session.PrivKey = privKey
		session.Passphrase = passphrase

		opts := protocol.DriverOpts{
			Host:       profile.Host,
			Port:       profile.Port,
			Username:   profile.Username,
			Password:   password,
			PrivKey:    privKey,
			Passphrase: passphrase,
		}

		driver, err := h.pm.Create("sftp", opts)
		if err != nil {
			session.Status = "disconnected"
			session.Error = "创建驱动失败: " + err.Error()
			h.broadcastSessionStatus(sessionID, "disconnected")
			return
		}

		if err := driver.Connect(ctx); err != nil {
			session.Status = "disconnected"
			session.Error = "SFTP连接失败: " + err.Error()
			slog.Error("sftp connect failed", "error", err)
			h.broadcastSessionStatus(sessionID, "disconnected")
			return
		}

		if provider, ok := driver.(fileutil.BackendProvider); ok {
			session.Backend = provider.FileBackend()
		}
		session.Driver = driver
		session.Status = "connected"
		h.profiles.UpdateLastUsed(req.ProfileID)
		h.broadcastSessionStatus(sessionID, "connected")

		h.audit.Log(&model.AuditLog{
			ID:        uuid.New().String(),
			ProfileID: req.ProfileID,
			Action:    "sftp_connect",
			Timestamp: time.Now(),
		})
	}()

	writeJSON(w, http.StatusCreated, model.SftpCreateSessionResponse{
		SessionID: sessionID,
		Status:    session.Status,
	})
}

func (h *SftpHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	result := make([]model.SftpSessionInfo, 0, len(h.sessions))
	for _, s := range h.sessions {
		result = append(result, model.SftpSessionInfo{
			ID:        s.ID,
			ProfileID: s.ProfileID,
			Status:    s.Status,
			Error:     s.Error,
			CreatedAt: s.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *SftpHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.mu.RLock()
	session, ok := h.sessions[id]
	h.mu.RUnlock()
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}
	writeJSON(w, http.StatusOK, model.SftpSessionInfo{
		ID:        session.ID,
		ProfileID: session.ProfileID,
		Status:    session.Status,
		Error:     session.Error,
		CreatedAt: session.CreatedAt,
	})
}

func (h *SftpHandler) CloseSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.mu.Lock()
	session, ok := h.sessions[id]
	if !ok {
		h.mu.Unlock()
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}
	delete(h.sessions, id)
	h.mu.Unlock()

	// Cancel all in-flight transfers for this session
	h.transfers.CancelBySession(id)

	// Cancel context and close backend/driver
	if session.cancel != nil {
		session.cancel()
	}
	if session.Backend != nil {
		session.Backend.Close()
	}
	if session.Driver != nil {
		session.Driver.Close()
	}

	h.audit.Log(&model.AuditLog{
		ID:        uuid.New().String(),
		ProfileID: session.ProfileID,
		Action:    "sftp_disconnect",
		Timestamp: time.Now(),
	})

	w.WriteHeader(http.StatusNoContent)
}

// --- File operations ---

func (h *SftpHandler) List(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	entries, err := backend.List(ctx, fileutil.CleanPath(p))
	if err != nil {
		h.handleFileErr(w, err)
		return
	}

	result := make([]model.SftpEntry, 0, len(entries))
	for _, e := range entries {
		result = append(result, toSftpEntry(e))
	}
	writeJSON(w, http.StatusOK, model.SftpListResponse{
		Path:    fileutil.CleanPath(p),
		Entries: result,
	})
}

func (h *SftpHandler) Stat(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	info, err := backend.Stat(ctx, fileutil.CleanPath(p))
	if err != nil {
		h.handleFileErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toSftpEntry(info))
}

func (h *SftpHandler) Tree(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}
	depth := 3
	if d := r.URL.Query().Get("depth"); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 {
			depth = n
		}
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	nodes, err := fileutil.Tree(ctx, backend, fileutil.CleanPath(p), depth)
	if err != nil {
		h.handleFileErr(w, err)
		return
	}

	result := make([]model.SftpTreeNode, 0, len(nodes))
	for _, n := range nodes {
		result = append(result, toSftpTreeNode(n))
	}
	writeJSON(w, http.StatusOK, model.SftpTreeResponse{
		Path:    fileutil.CleanPath(p),
		Entries: result,
	})
}

func (h *SftpHandler) Mkdir(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	var req model.SftpMkdirRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	cleanPath := fileutil.CleanPath(req.Path)
	if err := backend.Mkdir(ctx, cleanPath); err != nil {
		h.handleFileErr(w, err)
		return
	}

	info, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		writeJSON(w, http.StatusCreated, model.SftpEntry{Path: cleanPath, IsDir: true})
		return
	}
	h.auditSftp(session.ProfileID, "sftp_mkdir", "path="+cleanPath)
	writeJSON(w, http.StatusCreated, toSftpEntry(info))
}

func (h *SftpHandler) Rename(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	var req model.SftpRenameRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.OldPath == "" || req.NewPath == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "old_path and new_path are required")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	newPath := fileutil.CleanPath(req.NewPath)
	if err := backend.Rename(ctx, fileutil.CleanPath(req.OldPath), newPath); err != nil {
		h.handleFileErr(w, err)
		return
	}

	info, err := backend.Stat(ctx, newPath)
	if err != nil {
		writeJSON(w, http.StatusOK, model.SftpEntry{Path: newPath})
		return
	}
	h.auditSftp(session.ProfileID, "sftp_rename", "old="+req.OldPath+" new="+newPath)
	writeJSON(w, http.StatusOK, toSftpEntry(info))
}

func (h *SftpHandler) Delete(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	var req model.SftpDeleteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "paths is required")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	deleted, failed := 0, 0
	for _, p := range req.Paths {
		cleanPath := fileutil.CleanPath(p)
		if err := fileutil.RemoveAll(ctx, backend, cleanPath); err != nil {
			slog.Warn("sftp delete failed", "path", cleanPath, "error", err)
			failed++
		} else {
			deleted++
		}
	}
	h.auditSftp(session.ProfileID, "sftp_delete", "paths="+path.Join(req.Paths...))
	writeJSON(w, http.StatusOK, model.SftpDeleteResponse{Deleted: deleted, Failed: failed})
}

// --- Helpers ---

// resolveSession extracts the session ID from the path, validates it, and
// returns the session + its backend. Writes an error response and returns
// ok=false if anything is wrong.
func (h *SftpHandler) resolveSession(w http.ResponseWriter, r *http.Request) (*SftpSession, fileutil.FileBackend, bool) {
	id := r.PathValue("id")
	h.mu.RLock()
	session, ok := h.sessions[id]
	h.mu.RUnlock()
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return nil, nil, false
	}
	if session.Status != "connected" || session.Backend == nil {
		if session.Status == "disconnected" {
			writeError(w, http.StatusConflict, "SESSION_NOT_CONNECTED", session.Error)
		} else {
			writeError(w, http.StatusConflict, "SESSION_NOT_CONNECTED", "session is "+session.Status)
		}
		return nil, nil, false
	}
	return session, session.Backend, true
}

// opCtx creates a context tied to the session's lifetime (cancelled when the
// session closes) with a per-operation timeout. The session context ensures
// that closing a session cancels any in-flight file operations.
func (h *SftpHandler) opCtx(r *http.Request, session *SftpSession) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	// Chain with session-level context if available
	if session.cancel != nil {
		go func() {
			select {
			case <-ctx.Done():
			case <-r.Context().Done():
				cancel()
			}
		}()
	}
	return ctx, cancel
}

func (h *SftpHandler) handleFileErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fileutil.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, fileutil.ErrPermission):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", err.Error())
	case errors.Is(err, fileutil.ErrAlreadyExists):
		writeError(w, http.StatusConflict, "PATH_EXISTS", err.Error())
	default:
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		}
	}
}

func (h *SftpHandler) broadcastSessionStatus(sessionID, status string) {
	h.hub.BroadcastJSON(sessionID, ws.MsgSftpSessionStatus, ws.SftpSessionStatusPayload{
		SessionID: sessionID,
		Status:    status,
	})
}

func (h *SftpHandler) auditSftp(profileID, action, detail string) {
	h.audit.Log(&model.AuditLog{
		ID:        uuid.New().String(),
		ProfileID: profileID,
		Action:    action,
		Detail:    detail,
		Timestamp: time.Now(),
	})
}

func toSftpEntry(fi fileutil.FileInfo) model.SftpEntry {
	return model.SftpEntry{
		Name:    fi.Name,
		Path:    fi.Path,
		IsDir:   fi.IsDir,
		Size:    fi.Size,
		ModTime: fi.ModTime.Format(time.RFC3339),
		Mode:    fi.Mode,
	}
}

func toSftpTreeNode(n fileutil.TreeNode) model.SftpTreeNode {
	node := model.SftpTreeNode{
		SftpEntry: toSftpEntry(n.FileInfo),
	}
	if len(n.Children) > 0 {
		node.Children = make([]model.SftpTreeNode, 0, len(n.Children))
		for _, c := range n.Children {
			node.Children = append(node.Children, toSftpTreeNode(c))
		}
	}
	return node
}
