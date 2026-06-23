package ws

import (
	"log/slog"
	"sync"

	"github.com/coder/websocket"
)

type Hub struct {
	connections map[string]*Conn
	mu          sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{
		connections: make(map[string]*Conn),
	}
}

func (h *Hub) Register(sessionID string, conn *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Close existing connection for the same session
	if old, ok := h.connections[sessionID]; ok {
		old.Close()
	}

	h.connections[sessionID] = conn
	slog.Info("ws registered", "session_id", sessionID)
}

func (h *Hub) Unregister(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if conn, ok := h.connections[sessionID]; ok {
		conn.Close()
		delete(h.connections, sessionID)
		slog.Info("ws unregistered", "session_id", sessionID)
	}
}

func (h *Hub) Get(sessionID string) *Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connections[sessionID]
}

type Conn struct {
	SessionID string
	ws        *websocket.Conn
	send      chan []byte
	done      chan struct{}
}

func NewConn(sessionID string, ws *websocket.Conn) *Conn {
	return &Conn{
		SessionID: sessionID,
		ws:        ws,
		send:      make(chan []byte, 256),
		done:      make(chan struct{}),
	}
}

func (c *Conn) Send(data []byte) {
	select {
	case c.send <- data:
	default:
		// Buffer full, drop message
	}
}

func (c *Conn) Close() {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
}

func (c *Conn) Done() <-chan struct{} {
	return c.done
}

func (c *Conn) WS() *websocket.Conn {
	return c.ws
}
