package handler

import (
	"fmt"
	"time"
)

type ConnectionStage string

const (
	ConnectionStagePreparing       ConnectionStage = "preparing"
	ConnectionStageCredential      ConnectionStage = "credential"
	ConnectionStageHostKeyCheck    ConnectionStage = "hostkey_check"
	ConnectionStageHostKeyConfirm  ConnectionStage = "hostkey_confirm"
	ConnectionStageEstablishingSSH ConnectionStage = "establishing_ssh"
	ConnectionStageStartingShell   ConnectionStage = "starting_shell"
	ConnectionStageReady           ConnectionStage = "ready"
	ConnectionStageDisconnected    ConnectionStage = "disconnected"
)

type ConnectionLogEntry struct {
	At      int64  `json:"at"`
	Level   string `json:"level"`
	Stage   string `json:"stage"`
	Message string `json:"message"`
}

type SessionSnapshot struct {
	SessionID               string
	Status                  string
	Stage                   string
	Message                 string
	Error                   string
	WaitingForHostKey       bool
	HostKeyFingerprint      string
	KnownHostKeyFingerprint string
	Logs                    []ConnectionLogEntry
	Version                 int64
}

type hostKeyDecision struct {
	approved    bool
	fingerprint string
}

func newSession(id, profileID string, cancel func()) *Session {
	s := &Session{
		ID:              id,
		ProfileID:       profileID,
		Status:          "connecting",
		Stage:           string(ConnectionStagePreparing),
		CreatedAt:       time.Now(),
		cancelConnect:   cancel,
		hostKeyDecision: make(chan hostKeyDecision, 1),
		subscribers:     make(map[chan struct{}]struct{}),
	}
	s.appendLogLocked("info", ConnectionStagePreparing, "连接请求已创建，等待后端准备")
	return s
}

func (s *Session) setStage(stage ConnectionStage, level, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Stage = string(stage)
	s.LastMessage = message
	s.appendLogLocked(level, stage, message)
}

func (s *Session) setConnected(stage ConnectionStage, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Status = "connected"
	s.Stage = string(stage)
	s.LastMessage = message
	s.appendLogLocked("info", stage, message)
}

func (s *Session) setDisconnected(stage ConnectionStage, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Status = "disconnected"
	s.Stage = string(stage)
	s.Error = message
	s.LastMessage = message
	s.appendLogLocked("error", stage, message)
}

func (s *Session) setAbnormalDisconnect(reason, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Status = "error"
	s.DisconnectReason = reason
	s.Error = message
	s.Stage = string(ConnectionStageDisconnected)
	s.LastMessage = message
	s.appendLogLocked("error", ConnectionStageDisconnected, message)
}

func (s *Session) setHostKeyPrompt(currentFingerprint, knownFingerprint string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Status = "connecting"
	s.Stage = string(ConnectionStageHostKeyConfirm)
	s.WaitingForHostKey = true
	s.HostKeyFingerprint = currentFingerprint
	s.KnownHostKeyFingerprint = knownFingerprint
	s.LastMessage = "检测到服务器主机指纹变化，等待确认"
	s.appendLogLocked("warn", ConnectionStageHostKeyConfirm, s.LastMessage)
}

func (s *Session) clearHostKeyPrompt(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.WaitingForHostKey = false
	s.HostKeyFingerprint = ""
	s.KnownHostKeyFingerprint = ""
	if message != "" {
		s.LastMessage = message
		s.appendLogLocked("info", ConnectionStageHostKeyCheck, message)
	}
}

func (s *Session) confirmHostKey(fingerprint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.WaitingForHostKey {
		return fmt.Errorf("session is not waiting for host key confirmation")
	}
	expected := s.HostKeyFingerprint
	if expected != "" && fingerprint != "" && fingerprint != expected {
		return fmt.Errorf("host key fingerprint mismatch")
	}
	if fingerprint == "" {
		fingerprint = expected
	}
	select {
	case s.hostKeyDecision <- hostKeyDecision{approved: true, fingerprint: fingerprint}:
		return nil
	default:
		return fmt.Errorf("host key confirmation already submitted")
	}
}

func (s *Session) subscribe() (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	unsubscribe := func() {
		s.mu.Lock()
		delete(s.subscribers, ch)
		s.mu.Unlock()
		close(ch)
	}
	return ch, unsubscribe
}

func (s *Session) snapshot() SessionSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	logs := make([]ConnectionLogEntry, len(s.Logs))
	copy(logs, s.Logs)
	return SessionSnapshot{
		SessionID:               s.ID,
		Status:                  s.Status,
		Stage:                   s.Stage,
		Message:                 s.LastMessage,
		Error:                   s.Error,
		WaitingForHostKey:       s.WaitingForHostKey,
		HostKeyFingerprint:      s.HostKeyFingerprint,
		KnownHostKeyFingerprint: s.KnownHostKeyFingerprint,
		Logs:                    logs,
		Version:                 s.Version,
	}
}

func (s *Session) appendLog(level string, stage ConnectionStage, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastMessage = message
	s.appendLogLocked(level, stage, message)
}

func (s *Session) appendLogLocked(level string, stage ConnectionStage, message string) {
	s.Logs = append(s.Logs, ConnectionLogEntry{
		At:      time.Now().UnixMilli(),
		Level:   level,
		Stage:   string(stage),
		Message: message,
	})
	if len(s.Logs) > 200 {
		s.Logs = append([]ConnectionLogEntry(nil), s.Logs[len(s.Logs)-200:]...)
	}
	s.Version++
	s.notifySubscribersLocked()
}

func (s *Session) notifySubscribersLocked() {
	for ch := range s.subscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (s *Session) cancelPendingConnection() {
	s.mu.Lock()
	cancel := s.cancelConnect
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
