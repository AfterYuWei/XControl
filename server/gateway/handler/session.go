package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/protocol"
	"github.com/yuweinfo/xcontrol/store"
)

type Session struct {
	ID        string
	ProfileID string
	Driver    protocol.Driver
	Shell     protocol.Shell
	Status    string // connecting | connected | disconnected | error
	Error     string // error message when status is disconnected
	CreatedAt time.Time

	// DisconnectReason is set when the SSH connection dies abnormally
	// (remote_shutdown | network_error | keepalive_timeout | auth_failed | unknown).
	// Empty for normal shell exits. Protected by mu.
	DisconnectReason string
	mu               sync.Mutex
}

// IsAbnormalDisconnect reports whether the session ended due to an SSH
// connection death (as opposed to a normal shell exit).
func (s *Session) IsAbnormalDisconnect() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Status == "error" && s.DisconnectReason != ""
}

// DisconnectInfo returns the reason code and human-readable message if the
// session ended abnormally, empty strings otherwise.
func (s *Session) DisconnectInfo() (reason, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Status != "error" || s.DisconnectReason == "" {
		return "", ""
	}
	return s.DisconnectReason, humanizeDisconnectReason(s.DisconnectReason)
}

// humanizeDisconnectReason maps a machine-readable reason code to a
// human-readable message suitable for display in a status dialog.
func humanizeDisconnectReason(reason string) string {
	switch reason {
	case "remote_shutdown":
		return "远端服务器已关闭或重启"
	case "network_error":
		return "网络连接中断"
	case "keepalive_timeout":
		return "连接无响应（保活超时）"
	case "auth_failed":
		return "认证失败（凭据可能已变更）"
	default:
		return "未知原因"
	}
}

type SessionHandler struct {
	sessions map[string]*Session
	mu       sync.RWMutex
	profiles store.ProfileStore
	vault    store.VaultStore
	audit    store.AuditStore
	pm       *protocol.Manager
}

func NewSessionHandler(ps store.ProfileStore, vs store.VaultStore, as store.AuditStore, pm *protocol.Manager) *SessionHandler {
	return &SessionHandler{
		sessions: make(map[string]*Session),
		profiles: ps,
		vault:    vs,
		audit:    as,
		pm:       pm,
	}
}

func (h *SessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProfileID string `json:"profile_id"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.ProfileID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "profile_id is required")
		return
	}
	if req.Cols == 0 {
		req.Cols = 80
	}
	if req.Rows == 0 {
		req.Rows = 24
	}

	profile, err := h.profiles.Get(req.ProfileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}

	// Get credential from vault
	var password, privKey, passphrase, cert string
	if profile.VaultID != "" {
		cred, err := h.vault.Retrieve(profile.VaultID)
		if err != nil {
			slog.Warn("failed to retrieve vault credential", "error", err)
		} else {
			password = cred.Password
			privKey = cred.PrivKey
			passphrase = cred.Passphrase
			cert = cred.Cert
		}
	}

	sessionID := uuid.New().String()
	session := &Session{
		ID:        sessionID,
		ProfileID: req.ProfileID,
		Status:    "connecting",
		CreatedAt: time.Now(),
	}

	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	// Connect in background — use Background context since r.Context() is cancelled after response
	go func() {
		ctx := context.Background()

		opts := protocol.DriverOpts{
			Host:       profile.Host,
			Port:       profile.Port,
			Username:   profile.Username,
			Password:   password,
			PrivKey:    privKey,
			Passphrase: passphrase,
			Cert:       cert,
		}

		driver, err := h.pm.Create("ssh", opts)
		if err != nil {
			session.Status = "disconnected"
			session.Error = fmt.Sprintf("创建驱动失败: %v", err)
			slog.Error("create driver failed", "error", err)
			return
		}

		if err := driver.Connect(ctx); err != nil {
			session.Status = "disconnected"
			session.Error = fmt.Sprintf("SSH连接失败: %v", err)
			slog.Error("ssh connect failed", "error", err)
			return
		}

		session.Driver = driver

		// Register a death callback on the driver so that when the underlying
		// SSH connection dies (keepalive timeout, remote shutdown, network error),
		// the session status is updated to "error" with the reason. The WS
		// handler reads this to decide whether to send MsgDisconnect (abnormal)
		// or MsgExit (normal shell exit) to the frontend.
		if lc, ok := driver.(protocol.ConnectionLifecycle); ok {
			lc.OnDead(func(reason string) {
				session.mu.Lock()
				session.Status = "error"
				session.DisconnectReason = reason
				session.mu.Unlock()
				slog.Warn("session driver died", "session_id", sessionID, "reason", reason)
			})
		}

		shellOpts := protocol.ShellOptions{
			Cols: req.Cols,
			Rows: req.Rows,
		}
		shell, err := driver.RequestShell(shellOpts)
		if err != nil {
			session.Status = "disconnected"
			session.Error = fmt.Sprintf("启动Shell失败: %v", err)
			driver.Close()
			slog.Error("request shell failed", "error", err)
			return
		}

		session.Shell = shell
		session.Status = "connected"

		// Update last used
		h.profiles.UpdateLastUsed(req.ProfileID)

		// Audit log
		h.audit.Log(&model.AuditLog{
			ID:        uuid.New().String(),
			ProfileID: req.ProfileID,
			Action:    "connect",
			Timestamp: time.Now(),
		})

		// Wait for session to end. When the shell exits, check whether the
		// driver was marked dead (abnormal) — if so, the status is already
		// "error" and we leave it alone; otherwise this is a normal shell exit
		// and we mark the session as "disconnected".
		go func() {
			<-shell.Done()
			session.mu.Lock()
			if session.Status != "error" {
				session.Status = "disconnected"
			}
			session.mu.Unlock()
			h.audit.Log(&model.AuditLog{
				ID:        uuid.New().String(),
				ProfileID: req.ProfileID,
				Action:    "disconnect",
				Timestamp: time.Now(),
			})
		}()
	}()

	writeJSON(w, http.StatusCreated, map[string]string{
		"session_id": sessionID,
		"status":     session.Status,
	})
}

func (h *SessionHandler) List(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	type SessionInfo struct {
		ID        string `json:"id"`
		ProfileID string `json:"profile_id"`
		Status    string `json:"status"`
		CreatedAt string `json:"created_at"`
	}

	var result []SessionInfo
	for _, s := range h.sessions {
		result = append(result, SessionInfo{
			ID:        s.ID,
			ProfileID: s.ProfileID,
			Status:    s.Status,
			CreatedAt: s.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *SessionHandler) Close(w http.ResponseWriter, r *http.Request) {
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

	if session.Shell != nil {
		session.Shell.Close()
	}
	if session.Driver != nil {
		session.Driver.Close()
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) GetSession(id string) *Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[id]
}

func (h *SessionHandler) RemoveSession(id string) {
	h.mu.Lock()
	session, ok := h.sessions[id]
	if ok {
		delete(h.sessions, id)
	}
	h.mu.Unlock()

	// Close SSH resources if they exist
	if ok {
		if session.Shell != nil {
			session.Shell.Close()
		}
		if session.Driver != nil {
			session.Driver.Close()
		}
	}
}

func (h *SessionHandler) SendError(sessionID string, code, message string) {
	// This will be used by the WS handler
}

// handleResize is called by the WebSocket handler
func (h *SessionHandler) HandleResize(sessionID string, cols, rows int) {
	session := h.GetSession(sessionID)
	if session == nil || session.Shell == nil {
		return
	}
	if err := session.Shell.Resize(cols, rows); err != nil {
		slog.Error("resize failed", "session_id", sessionID, "error", err)
	}
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
