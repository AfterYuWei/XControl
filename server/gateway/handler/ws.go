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
	"unicode/utf8"

	"github.com/coder/websocket"
	sshproto "github.com/yuweinfo/xcontrol/protocol/ssh"
	"github.com/yuweinfo/xcontrol/ws"
)

type WSHandler struct {
	hub      *ws.Hub
	sessions *SessionHandler
}

const sessionReadyTimeout = sshproto.DefaultConnectTimeout + 15*time.Second

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

	session := h.waitForSessionExists(sessionID, 5*time.Second)
	if session == nil {
		h.sendWSMessage(wsConn, ws.MsgError, "", ws.ErrorPayload{
			Code:    "SESSION_NOT_FOUND",
			Message: "session not found",
		})
		wsConn.Close(websocket.StatusPolicyViolation, "session not found")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go h.readPump(ctx, conn, session)

	if !h.waitForTerminalReady(ctx, conn, wsConn, session) {
		return
	}

	// Inject OSC 7 configuration before metadata and terminal output.
	h.injectOSC7Config(session)
	session.setConnected(ConnectionStageReady, "终端已就绪，开始接收远程输出")
	h.sendConnectionState(wsConn, session.snapshot())

	info := session.Driver.Info()
	h.sendWSMessage(wsConn, ws.MsgMeta, "", ws.MetaPayload{
		SessionID: sessionID,
		Host:      info.Host,
		Username:  info.Username,
		Protocol:  info.Protocol,
	})

	h.writePump(ctx, conn, session)
}

func (h *WSHandler) waitForSessionExists(sessionID string, timeout time.Duration) *Session {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		session := h.sessions.GetSession(sessionID)
		if session != nil {
			return session
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func (h *WSHandler) waitForTerminalReady(ctx context.Context, conn *ws.Conn, wsConn *websocket.Conn, session *Session) bool {
	updates, unsubscribe := session.subscribe()
	defer unsubscribe()

	lastVersion := int64(-1)
	sendSnapshot := func() SessionSnapshot {
		snapshot := session.snapshot()
		if snapshot.Version != lastVersion {
			h.sendConnectionState(wsConn, snapshot)
			lastVersion = snapshot.Version
		}
		return snapshot
	}

	snapshot := sendSnapshot()
	for {
		if snapshot.Status == "connected" && session.Shell != nil {
			return true
		}
		if snapshot.Status == "disconnected" || snapshot.Status == "error" {
			message := snapshot.Error
			if message == "" {
				message = snapshot.Message
			}
			if message == "" {
				message = "connection failed"
			}
			h.sendWSMessage(wsConn, ws.MsgError, "", ws.ErrorPayload{
				Code:    "SESSION_FAILED",
				Message: message,
			})
			wsConn.Close(websocket.StatusPolicyViolation, "session failed")
			return false
		}

		select {
		case <-ctx.Done():
			return false
		case <-conn.Done():
			return false
		case <-updates:
			snapshot = sendSnapshot()
		case <-time.After(sessionReadyTimeout):
			h.sendWSMessage(wsConn, ws.MsgError, "", ws.ErrorPayload{
				Code:    "SESSION_TIMEOUT",
				Message: "connection timeout",
			})
			wsConn.Close(websocket.StatusPolicyViolation, "session timeout")
			return false
		}
	}
}

func (h *WSHandler) sendConnectionState(wsConn *websocket.Conn, snapshot SessionSnapshot) {
	logs := make([]ws.ConnectionLogPayload, 0, len(snapshot.Logs))
	for _, entry := range snapshot.Logs {
		logs = append(logs, ws.ConnectionLogPayload{
			At:      entry.At,
			Level:   entry.Level,
			Stage:   entry.Stage,
			Message: entry.Message,
		})
	}
	h.sendWSMessage(wsConn, ws.MsgConnectionState, "", ws.ConnectionStatePayload{
		SessionID:               snapshot.SessionID,
		Status:                  snapshot.Status,
		Stage:                   snapshot.Stage,
		Message:                 snapshot.Message,
		Error:                   snapshot.Error,
		WaitingForHostKey:       snapshot.WaitingForHostKey,
		HostKeyFingerprint:      snapshot.HostKeyFingerprint,
		KnownHostKeyFingerprint: snapshot.KnownHostKeyFingerprint,
		Logs:                    logs,
	})
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

		case ws.MsgCompleteRequest:
			// 异步处理，避免补全请求阻塞后续 input/resize。
			go h.handleComplete(wsConn.WS(), session, msg.Payload)
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
	var utf8Carry []byte // Incomplete UTF-8 trailing bytes from previous read

	// Filter control for injected OSC 7 config command
	// Uses a buffer to handle network packet fragmentation
	isFilteringInit := true
	initTarget := []byte(`__osc7_cwd`) // Match unique function name (robust against ANSI color codes)
	var initFilterBuf []byte
	var totalInitSeen int // Total bytes seen by the init filter (for safety fallback)
	var readCount int     // Read counter for debugging

	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done():
			return
		case <-session.Shell.Done():
			// Brief grace period to let the driver's OnDead callback fire and
			// set session.Status = "error" with a reason.
			select {
			case <-time.After(50 * time.Millisecond):
			case <-ctx.Done():
				return
			}
			reason, message := session.DisconnectInfo()
			if reason != "" {
				h.sendWSMessage(wsConn.WS(), ws.MsgDisconnect, "", ws.DisconnectPayload{
					Reason:  reason,
					Message: message,
				})
			} else {
				h.sendWSMessage(wsConn.WS(), ws.MsgExit, "", ws.ExitPayload{
					Code: session.Shell.ExitCode(),
				})
			}
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
				readCount++
				hasCmdInRead := bytes.Contains(buf[:n], []byte("__osc7_cwd"))
				slog.Debug("writePump: shell read", "read_count", readCount, "n", n, "is_filtering", isFilteringInit, "contains_osc7_cmd", hasCmdInRead)

				data := append(utf8Carry, buf[:n]...)
				utf8Carry = trimIncompleteUTF8(data)
				if len(utf8Carry) > 0 {
					data = data[:len(data)-len(utf8Carry)]
				}

				if isFilteringInit {
					initFilterBuf = append(initFilterBuf, data...)
					totalInitSeen += len(data)

					if firstIdx := bytes.Index(initFilterBuf, initTarget); firstIdx != -1 {
						lastIdx := bytes.LastIndex(initFilterBuf, initTarget)
						slog.Debug("init filter: target found", "first_idx", firstIdx, "last_idx", lastIdx, "buf_len", len(initFilterBuf), "total_seen", totalInitSeen)
						lineStart := firstIdx
						for lineStart > 0 && initFilterBuf[lineStart-1] != '\n' {
							lineStart--
						}
						endIdx := bytes.Index(initFilterBuf[lastIdx:], []byte("\n"))

						if endIdx != -1 {
							lineEnd := lastIdx + endIdx + 1
							cleanedData := append([]byte{}, initFilterBuf[:lineStart]...)
							cleanedData = append(cleanedData, initFilterBuf[lineEnd:]...)
							data = cleanedData
							isFilteringInit = false
							initFilterBuf = nil
							slog.Debug("init filter: command echo lines removed", "line_start", lineStart, "line_end", lineEnd, "removed_bytes", lineEnd-lineStart, "data_len", len(data))
						} else {
							data = append([]byte{}, initFilterBuf[:lineStart]...)
							initFilterBuf = append([]byte{}, initFilterBuf[lineStart:]...)
						}
					} else {
						preview := initFilterBuf
						if len(preview) > 300 {
							preview = preview[:300]
						}
						slog.Debug("init filter: target not found", "buf_len", len(initFilterBuf), "total_seen", totalInitSeen, "buf_preview", string(preview))
						keepLen := len(initTarget) - 1
						if len(initFilterBuf) > keepLen {
							data = append([]byte{}, initFilterBuf[:len(initFilterBuf)-keepLen]...)
							initFilterBuf = append([]byte{}, initFilterBuf[len(initFilterBuf)-keepLen:]...)
						} else {
							data = nil
						}

						if totalInitSeen > 10240 {
							slog.Debug("init filter: safety fallback triggered, disabling filter", "total_seen", totalInitSeen, "buf_len", len(initFilterBuf))
							isFilteringInit = false
							data = append(data, initFilterBuf...)
							initFilterBuf = nil
						}
					}
				}

				if !isFilteringInit {
					osc7Buffer = append(osc7Buffer, data...)
					cwd := extractOSC7(&osc7Buffer)
					if cwd != "" {
						h.sendWSMessage(wsConn.WS(), ws.MsgCwd, "", ws.CwdPayload{
							Path: cwd,
						})
					}
				}

				if len(data) > 0 {
					hasCmd := bytes.Contains(data, []byte("__osc7_cwd"))
					slog.Debug("writePump: sending data to frontend", "data_len", len(data), "contains_osc7_cmd", hasCmd)
					h.sendWSMessage(wsConn.WS(), ws.MsgOutput, string(data), nil)
				}
			}
		}
	}
}

// extractOSC7 extracts the current working directory from OSC 7 escape sequences.
// OSC 7 format: \x1b]7;file://hostname/path\x07
func extractOSC7(buf *[]byte) string {
	osc7Prefix := []byte{0x1b, ']', '7', ';'}
	belByte := byte(0x07)
	stSequence := []byte{0x1b, '\\'}

	var result string

	for {
		startIdx := bytes.Index(*buf, osc7Prefix)
		if startIdx == -1 {
			keepLen := len(osc7Prefix) - 1
			if len(*buf) > keepLen {
				*buf = (*buf)[len(*buf)-keepLen:]
			}
			break
		}

		searchFrom := startIdx + len(osc7Prefix)
		endIdx := -1
		terminatorLen := 0

		for i := searchFrom; i < len(*buf); i++ {
			if (*buf)[i] == belByte {
				endIdx = i
				terminatorLen = 1
				break
			}
		}

		if endIdx == -1 {
			stIdx := bytes.Index((*buf)[searchFrom:], stSequence)
			if stIdx != -1 {
				endIdx = searchFrom + stIdx
				terminatorLen = len(stSequence)
			}
		}

		if endIdx == -1 {
			*buf = (*buf)[startIdx:]
			break
		}

		uri := string((*buf)[searchFrom:endIdx])
		*buf = (*buf)[endIdx+terminatorLen:]

		if strings.HasPrefix(uri, "file://") {
			parsedURL, err := url.Parse(uri)
			if err == nil && parsedURL.Path != "" {
				result = parsedURL.Path
			}
		}
	}

	return result
}

// trimIncompleteUTF8 returns trailing bytes from buf that form an incomplete
// UTF-8 sequence. These bytes should be prepended to the next read.
func trimIncompleteUTF8(buf []byte) []byte {
	if len(buf) == 0 {
		return nil
	}
	for i := 1; i <= utf8.UTFMax && i <= len(buf); i++ {
		r, size := utf8.DecodeRune(buf[len(buf)-i:])
		if r != utf8.RuneError || size != 1 {
			if i > 1 {
				return buf[len(buf)-(i-1):]
			}
			return nil
		}
	}
	n := utf8.UTFMax
	if n > len(buf) {
		n = len(buf)
	}
	return buf[len(buf)-n:]
}

// injectOSC7Config injects OSC 7 terminal directory tracking configuration.
func (h *WSHandler) injectOSC7Config(session *Session) {
	if session == nil || session.Shell == nil {
		return
	}

	osc7Cmd := ` __osc7_cwd() { printf "\033]7;file://%s%s\007" "$(hostname)" "$PWD"; }; `
	osc7Cmd += `if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__osc7_cwd); `
	osc7Cmd += `elif [ -n "$BASH_VERSION" ]; then `
	osc7Cmd += `[[ "$PROMPT_COMMAND" != *__osc7_cwd* ]] && PROMPT_COMMAND="__osc7_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi`
	session.Shell.Write([]byte(osc7Cmd + "\n"))
	slog.Debug("osc7 config command injected", "cmd_len", len(osc7Cmd)+1)

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
