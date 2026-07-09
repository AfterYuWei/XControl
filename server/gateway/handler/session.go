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
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/protocol"
	sshproto "github.com/yuweinfo/xcontrol/protocol/ssh"
	"github.com/yuweinfo/xcontrol/store"
)

type Session struct {
	ID          string
	ProfileID   string
	Driver      protocol.Driver
	Shell       protocol.Shell
	Status      string // connecting | connected | disconnected | error
	Error       string // error message when status is disconnected
	CreatedAt   time.Time
	Stage       string
	LastMessage string
	Logs        []ConnectionLogEntry

	// DisconnectReason is set when the SSH connection dies abnormally
	// (remote_shutdown | network_error | keepalive_timeout | auth_failed | unknown).
	// Empty for normal shell exits. Protected by mu.
	DisconnectReason        string
	WaitingForHostKey       bool
	HostKeyFingerprint      string
	KnownHostKeyFingerprint string
	Version                 int64
	cancelConnect           func()
	hostKeyDecision         chan hostKeyDecision
	subscribers             map[chan struct{}]struct{}
	mu                      sync.Mutex
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
		return "网络连接已中断"
	case "keepalive_timeout":
		return "连接无响应，保活检测超时"
	case "auth_failed":
		return "认证失败，凭据可能已变更"
	default:
		return "连接因未知原因中断"
	}
}

type SessionHandler struct {
	sessions  map[string]*Session
	mu        sync.RWMutex
	profiles  store.ProfileStore
	vault     store.VaultStore
	encryptor *crypto.Encryptor
	audit     store.AuditStore
	pm        *protocol.Manager
}

func NewSessionHandler(ps store.ProfileStore, vs store.VaultStore, enc *crypto.Encryptor, as store.AuditStore, pm *protocol.Manager) *SessionHandler {
	return &SessionHandler{
		sessions:  make(map[string]*Session),
		profiles:  ps,
		vault:     vs,
		encryptor: enc,
		audit:     as,
		pm:        pm,
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

	sessionID := uuid.New().String()
	ctx, cancel := context.WithCancel(context.Background())
	session := newSession(sessionID, req.ProfileID, cancel)

	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	session.setStage(ConnectionStagePreparing, "info", "已读取连接配置，准备建立 SSH 会话")

	go h.connectSession(ctx, session, profile, req.Cols, req.Rows)

	writeJSON(w, http.StatusCreated, map[string]string{
		"session_id": sessionID,
		"status":     session.Status,
	})
}

func (h *SessionHandler) connectSession(ctx context.Context, session *Session, profile *model.Profile, cols, rows int) {
	session.setStage(ConnectionStageCredential, "info", "正在准备连接凭据")

	var password, privKey, passphrase string
	cred, err := resolveProfileCredential(profile, h.vault, h.encryptor)
	if err != nil {
		session.appendLog("warn", ConnectionStageCredential, fmt.Sprintf("读取连接凭据失败，将继续尝试连接: %v", err))
		slog.Warn("failed to resolve profile credential", "profile_id", profile.ID, "error", err)
	} else if cred != nil {
		password = cred.Password
		privKey = cred.PrivKey
		passphrase = cred.Passphrase
		if password == "" && privKey == "" {
			session.appendLog("info", ConnectionStageCredential, "未检测到密码或私钥，将尝试无凭据连接")
		} else {
			session.appendLog("info", ConnectionStageCredential, "连接凭据已就绪")
		}
	}

	session.setStage(ConnectionStageHostKeyCheck, "info", "正在检查服务器主机指纹")
	knownHostKeyFingerprint := profileHostKeyFingerprint(profile.Options)
	currentHostKeyFingerprint, err := sshproto.InspectHostKeyFingerprint(ctx, protocol.DriverOpts{
		Host:     profile.Host,
		Port:     profile.Port,
		Username: profile.Username,
	})
	if err != nil {
		session.setDisconnected(ConnectionStageHostKeyCheck, fmt.Sprintf("主机指纹检查失败: %v", err))
		slog.Error("inspect host key failed", "profile_id", profile.ID, "error", err)
		return
	}
	session.appendLog("info", ConnectionStageHostKeyCheck, fmt.Sprintf("服务器主机指纹: %s", currentHostKeyFingerprint))

	if knownHostKeyFingerprint != "" && knownHostKeyFingerprint != currentHostKeyFingerprint {
		session.setHostKeyPrompt(currentHostKeyFingerprint, knownHostKeyFingerprint)
		select {
		case decision := <-session.hostKeyDecision:
			if !decision.approved {
				session.setDisconnected(ConnectionStageHostKeyConfirm, "用户取消了主机指纹确认")
				return
			}
			session.clearHostKeyPrompt("新的主机指纹已确认，继续建立连接")
		case <-ctx.Done():
			session.setDisconnected(ConnectionStageHostKeyConfirm, "连接已取消")
			return
		}
	}

	session.setStage(ConnectionStageEstablishingSSH, "info", "正在建立 TCP 连接并协商 SSH 安全通道")
	opts := protocol.DriverOpts{
		Host:               profile.Host,
		Port:               profile.Port,
		Username:           profile.Username,
		Password:           password,
		PrivKey:            privKey,
		Passphrase:         passphrase,
		HostKeyFingerprint: currentHostKeyFingerprint,
	}

	driver, err := h.pm.Create("ssh", opts)
	if err != nil {
		session.setDisconnected(ConnectionStageEstablishingSSH, fmt.Sprintf("创建 SSH 驱动失败: %v", err))
		slog.Error("create driver failed", "profile_id", profile.ID, "error", err)
		return
	}

	if err := driver.Connect(ctx); err != nil {
		session.setDisconnected(ConnectionStageEstablishingSSH, fmt.Sprintf("SSH 握手或认证失败: %v", err))
		slog.Error("ssh connect failed", "profile_id", profile.ID, "error", err)
		return
	}

	session.mu.Lock()
	session.Driver = driver
	session.mu.Unlock()
	session.appendLog("info", ConnectionStageEstablishingSSH, "SSH 握手完成，认证通过")

	if lc, ok := driver.(protocol.ConnectionLifecycle); ok {
		lc.OnDead(func(reason string) {
			message := humanizeDisconnectReason(reason)
			session.setAbnormalDisconnect(reason, message)
			slog.Warn("session driver died", "session_id", session.ID, "reason", reason)
		})
	}

	session.setStage(ConnectionStageStartingShell, "info", "正在启动远程 Shell")
	shellOpts := protocol.ShellOptions{
		Cols: cols,
		Rows: rows,
	}
	shell, err := driver.RequestShell(shellOpts)
	if err != nil {
		session.setDisconnected(ConnectionStageStartingShell, fmt.Sprintf("启动 Shell 失败: %v", err))
		driver.Close()
		slog.Error("request shell failed", "profile_id", profile.ID, "error", err)
		return
	}

	session.mu.Lock()
	session.Shell = shell
	session.mu.Unlock()
	session.setConnected(ConnectionStageStartingShell, "远程 Shell 已启动，等待终端附着")

	if knownHostKeyFingerprint != currentHostKeyFingerprint {
		if nextOptions, optErr := withProfileHostKeyFingerprint(profile.Options, currentHostKeyFingerprint); optErr != nil {
			slog.Warn("failed to encode host key fingerprint", "profile_id", profile.ID, "error", optErr)
		} else if err := h.profiles.Update(profile.ID, &model.ProfileUpdateRequest{Options: &nextOptions}); err != nil {
			slog.Warn("failed to persist host key fingerprint", "profile_id", profile.ID, "error", err)
		} else {
			session.appendLog("info", ConnectionStageHostKeyCheck, "新的主机指纹已保存到连接配置")
		}
	}

	h.profiles.UpdateLastUsed(profile.ID)
	h.audit.Log(&model.AuditLog{
		ID:        uuid.New().String(),
		ProfileID: profile.ID,
		Action:    "connect",
		Timestamp: time.Now(),
	})

	go func() {
		<-shell.Done()
		session.mu.Lock()
		if session.Status != "error" {
			session.Status = "disconnected"
			session.Stage = string(ConnectionStageDisconnected)
			session.LastMessage = "会话已结束"
			session.appendLogLocked("info", ConnectionStageDisconnected, "远程 Shell 已结束")
		}
		session.mu.Unlock()
		h.audit.Log(&model.AuditLog{
			ID:        uuid.New().String(),
			ProfileID: profile.ID,
			Action:    "disconnect",
			Timestamp: time.Now(),
		})
	}()
}

func (h *SessionHandler) ConfirmHostKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	session := h.GetSession(id)
	if session == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}

	var req struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if err := session.confirmHostKey(req.Fingerprint); err != nil {
		writeError(w, http.StatusConflict, "HOST_KEY_CONFIRM_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
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

	session.cancelPendingConnection()
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

	if ok {
		session.cancelPendingConnection()
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

// HandleResize is called by the WebSocket handler.
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
