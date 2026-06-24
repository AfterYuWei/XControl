package ws

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/coder/websocket"
)

// SftpHub is a dedicated Hub instance for SFTP transfer progress notifications.
// It is kept separate from the terminal Hub so session IDs never collide and
// terminal traffic is unaffected.
type SftpHub = Hub

// NewSftpHub creates a fresh Hub for SFTP WebSocket connections.
func NewSftpHub() *SftpHub {
	return NewHub()
}

// Broadcast sends a message to the WebSocket connection for a given session ID.
// If no connection is registered (e.g. user closed the panel), the message is
// silently dropped.
func (h *Hub) Broadcast(sessionID string, msg *Message) {
	conn := h.Get(sessionID)
	if conn == nil {
		return
	}
	data, err := MarshalMessage(msg)
	if err != nil {
		return
	}
	conn.Send(data)
}

// BroadcastJSON is a convenience wrapper that marshals a payload into a Message.
func (h *Hub) BroadcastJSON(sessionID string, msgType MessageType, payload any) {
	msg := &Message{Type: msgType}
	if payload != nil {
		b, _ := json.Marshal(payload)
		msg.Payload = b
	}
	h.Broadcast(sessionID, msg)
}

// AcceptSftpWS upgrades an HTTP connection to a WebSocket and registers it in
// the SFTP hub. It runs a read loop that only handles ping/pong (SFTP clients
// don't send data — the connection is server-push only).
func (h *Hub) AcceptSftpWS(w interface{ Header() interface{} }, r interface{}, sessionID string) {
	// This is a placeholder — actual accept logic is in the handler package
	// which has access to net/http types.
	_ = sessionID
}

// ReadLoop reads messages from the WebSocket, handling only ping. The connection
// is server-push only; client messages (other than ping) are ignored.
func (h *Hub) ReadLoop(ctx context.Context, conn *Conn) {
	wsConn := conn.WS()
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done():
			return
		default:
		}
		_, data, err := wsConn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway {
				return
			}
			slog.Debug("sftp ws read error", "session_id", conn.SessionID, "error", err)
			return
		}
		msg, err := ParseMessage(data)
		if err != nil {
			continue
		}
		if msg.Type == MsgPing {
			wsConn.Write(ctx, websocket.MessageText, mustMarshal(&Message{Type: MsgPong}))
		}
	}
}

func mustMarshal(msg *Message) []byte {
	b, _ := MarshalMessage(msg)
	return b
}
