package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/yuweinfo/sshx/ws"
)

type WSHandler struct {
	hub      *ws.Hub
	sessions *SessionHandler
}

func NewWSHandler(hub *ws.Hub, sh *SessionHandler) *WSHandler {
	return &WSHandler{hub: hub, sessions: sh}
}

func (h *WSHandler) Handle(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "session_id is required")
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("ws accept failed", "error", err)
		return
	}

	conn := ws.NewConn(sessionID, wsConn)
	h.hub.Register(sessionID, conn)
	defer h.hub.Unregister(sessionID)

	// Wait for session to be ready
	session := h.waitForSession(sessionID, 30*time.Second)
	if session == nil {
		// Check if there's a specific error from the session
		errMsg := "session not found or connection timeout"
		if s := h.sessions.GetSession(sessionID); s != nil && s.Error != "" {
			errMsg = s.Error
		}
		h.sendWSMessage(wsConn, ws.MsgError, "", ws.ErrorPayload{
			Code:    "SESSION_FAILED",
			Message: errMsg,
		})
		wsConn.Close(websocket.StatusPolicyViolation, "session failed")
		return
	}

	// Inject OSC 7 configuration BEFORE sending metadata and starting data flow
	// This happens while frontend is still showing "connecting" dialog
	h.injectOSC7Config(session)

	// Send metadata
	info := session.Driver.Info()
	h.sendWSMessage(wsConn, ws.MsgMeta, "", ws.MetaPayload{
		SessionID: sessionID,
		Host:      info.Host,
		Username:  info.Username,
		Protocol:  info.Protocol,
	})

	// Start read/write pumps
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go h.readPump(ctx, conn, session)
	h.writePump(ctx, conn, session)
}

func (h *WSHandler) waitForSession(sessionID string, timeout time.Duration) *Session {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		session := h.sessions.GetSession(sessionID)
		if session == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		// Connection succeeded
		if session.Status == "connected" && session.Shell != nil {
			return session
		}
		// Connection failed — don't wait for timeout
		if session.Status == "disconnected" {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func (h *WSHandler) readPump(ctx context.Context, conn *ws.Conn, session *Session) {
	wsConn := h.hub.Get(conn.SessionID)
	if wsConn == nil {
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done():
			return
		default:
		}

		_, data, err := wsConn.WS().Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway {
				return
			}
			slog.Error("ws read error", "session_id", conn.SessionID, "error", err)
			return
		}

		msg, err := ws.ParseMessage(data)
		if err != nil {
			slog.Error("parse message error", "error", err)
			continue
		}

		switch msg.Type {
		case ws.MsgInput:
			if session.Shell != nil {
				if _, err := session.Shell.Write([]byte(msg.Data)); err != nil {
					slog.Error("shell write error", "error", err)
					return
				}
			}

		case ws.MsgResize:
			var payload ws.ResizePayload
			if err := json.Unmarshal(msg.Payload, &payload); err == nil {
				h.sessions.HandleResize(conn.SessionID, payload.Cols, payload.Rows)
			}

		case ws.MsgPing:
			h.sendWSMessage(wsConn.WS(), ws.MsgPong, "", nil)
		}
	}
}

func (h *WSHandler) writePump(ctx context.Context, conn *ws.Conn, session *Session) {
	wsConn := h.hub.Get(conn.SessionID)
	if wsConn == nil {
		return
	}

	defer func() {
		h.sessions.RemoveSession(conn.SessionID)
	}()

	buf := make([]byte, 4096)
	var osc7Buffer []byte

	// Filter control for injected OSC 7 config command
	// Uses a buffer to handle network packet fragmentation
	isFilteringInit := true
	initTarget := []byte(` __osc7_cwd()`) // Leading space to match the command with space prefix
	var initFilterBuf []byte

	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done():
			return
		case <-session.Shell.Done():
			h.sendWSMessage(wsConn.WS(), ws.MsgExit, "", ws.ExitPayload{
				Code: session.Shell.ExitCode(),
			})
			wsConn.WS().Close(websocket.StatusNormalClosure, "session ended")
			return
		default:
			n, err := session.Shell.Read(buf)
			if err != nil {
				select {
				case <-session.Shell.Done():
					return
				default:
					slog.Error("shell read error", "error", err)
					return
				}
			}
			if n > 0 {
				data := buf[:n]

				// Surgical filter for injected OSC 7 config command
				// Handles network packet fragmentation gracefully
				if isFilteringInit {
					initFilterBuf = append(initFilterBuf, data...)

					if idx := bytes.Index(initFilterBuf, initTarget); idx != -1 {
						// Found command start, safely find line end (\n)
						endIdx := bytes.Index(initFilterBuf[idx:], []byte("\n"))

						if endIdx != -1 {
							actualEnd := idx + endIdx + 1
							// Precise removal: keep data before command (Banner/MOTD) and after (Prompt)
							cleanedData := append([]byte{}, initFilterBuf[:idx]...)
							cleanedData = append(cleanedData, initFilterBuf[actualEnd:]...)
							data = cleanedData
							isFilteringInit = false // Done, disable filter
							initFilterBuf = nil     // Release memory
						} else {
							// Found start but no newline (truncated by network)
							// Send data before command start, hold the rest
							data = append([]byte{}, initFilterBuf[:idx]...)
							initFilterBuf = initFilterBuf[idx:]
						}
					} else {
						// Command not seen yet (Banner may be split across packets)
						data = initFilterBuf
						initFilterBuf = nil

						// Safety fallback: disable filter if no command found after 10KB
						if len(data) > 10240 {
							isFilteringInit = false
						}
					}
				}

				// Process OSC 7 sequences (only after filtering is complete)
				if !isFilteringInit {
					osc7Buffer = append(osc7Buffer, data...)
					cwd := extractOSC7(&osc7Buffer)
					if cwd != "" {
						h.sendWSMessage(wsConn.WS(), ws.MsgCwd, "", ws.CwdPayload{
							Path: cwd,
						})
					}
				}

				// Send to frontend (clean data with command filtered out)
				if len(data) > 0 {
					h.sendWSMessage(wsConn.WS(), ws.MsgOutput, string(data), nil)
				}
			}
		}
	}
}

// extractOSC7 extracts the current working directory from OSC 7 escape sequences.
// OSC 7 format: \x1b]7;file://hostname/path\x07
// Returns the path portion if found, empty string otherwise.
func extractOSC7(buf *[]byte) string {
	// OSC 7 starts with ESC ] 7 ;
	osc7Prefix := []byte{0x1b, ']', '7', ';'}
	// Ends with BEL (0x07) or ST (ESC \)
	belByte := byte(0x07)
	stSequence := []byte{0x1b, '\\'}

	var result string

	for {
		// Find start of OSC 7
		startIdx := bytes.Index(*buf, osc7Prefix)
		if startIdx == -1 {
			// Keep last len(osc7Prefix)-1 bytes in case of partial match
			keepLen := len(osc7Prefix) - 1
			if len(*buf) > keepLen {
				*buf = (*buf)[len(*buf)-keepLen:]
			}
			break
		}

		// Find end of OSC 7 (BEL or ST)
		searchFrom := startIdx + len(osc7Prefix)
		endIdx := -1
		terminatorLen := 0

		// Look for BEL
		for i := searchFrom; i < len(*buf); i++ {
			if (*buf)[i] == belByte {
				endIdx = i
				terminatorLen = 1
				break
			}
		}

		// If BEL not found, look for ST
		if endIdx == -1 {
			stIdx := bytes.Index((*buf)[searchFrom:], stSequence)
			if stIdx != -1 {
				endIdx = searchFrom + stIdx
				terminatorLen = len(stSequence)
			}
		}

		if endIdx == -1 {
			// Incomplete sequence, keep it in buffer
			*buf = (*buf)[startIdx:]
			break
		}

		// Extract the URI: file://hostname/path
		uri := string((*buf)[searchFrom:endIdx])

		// Remove processed bytes
		*buf = (*buf)[endIdx+terminatorLen:]

		// Parse the URI
		if strings.HasPrefix(uri, "file://") {
			// Parse URL to get path
			parsedURL, err := url.Parse(uri)
			if err == nil && parsedURL.Path != "" {
				result = parsedURL.Path
			}
		}
	}

	return result
}

// injectOSC7Config injects OSC 7 terminal directory tracking configuration
// This runs before the data flow starts, so the output won't be visible to the user
func (h *WSHandler) injectOSC7Config(session *Session) {
	if session == nil || session.Shell == nil {
		return
	}

	// Send OSC 7 setup command with leading space to suppress history recording
	// The leading space tells bash/zsh not to add this command to history
	osc7Cmd := ` __osc7_cwd() { printf "\033]7;file://%s%s\007" "$(hostname)" "$PWD"; }; `
	osc7Cmd += `if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__osc7_cwd); `
	osc7Cmd += `elif [ -n "$BASH_VERSION" ]; then `
	osc7Cmd += `[[ "$PROMPT_COMMAND" != *__osc7_cwd* ]] && PROMPT_COMMAND="__osc7_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi`
	session.Shell.Write([]byte(osc7Cmd + "\n"))

	// Wait for the command to execute before frontend starts receiving
	time.Sleep(200 * time.Millisecond)
}

func (h *WSHandler) sendWSMessage(wsConn *websocket.Conn, msgType ws.MessageType, data string, payload any) {
	msg := &ws.Message{
		Type: msgType,
		Data: data,
	}
	if payload != nil {
		b, _ := json.Marshal(payload)
		msg.Payload = b
	}
	jsonData, err := ws.MarshalMessage(msg)
	if err != nil {
		return
	}
	wsConn.Write(context.Background(), websocket.MessageText, jsonData)
}
