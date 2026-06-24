package handler

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/coder/websocket"
	"github.com/yuweinfo/sshx/ws"
)

// HandleWS upgrades the HTTP connection to a WebSocket for SFTP transfer
// progress notifications. The connection is server-push only; clients may
// send ping messages (responded to with pong).
func (h *SftpHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "session_id is required")
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("sftp ws accept failed", "error", err)
		return
	}

	conn := ws.NewConn(sessionID, wsConn)
	h.hub.Register(sessionID, conn)
	defer h.hub.Unregister(sessionID)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Send session status on connect
	h.mu.RLock()
	session, ok := h.sessions[sessionID]
	h.mu.RUnlock()
	if ok {
		h.broadcastSessionStatus(sessionID, session.Status)
	}

	// Run read loop (handles ping/pong); blocks until connection closes
	h.hub.ReadLoop(ctx, conn)
}
