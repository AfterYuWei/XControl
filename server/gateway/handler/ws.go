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
	"github.com/yuweinfo/xcontrol/protocol"
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
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return h.sessions.WaitForSession(ctx, sessionID, timeout)
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
			// Forward the ping through the SSH connection so the measured RTT
			// reflects the real latency to the remote host. Handled async to
			// avoid blocking input/resize processing on high-latency links.
			go h.handlePing(wsConn.WS(), session)

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
	const osc7BufferMaxSize = 1024 * 1024 // 1MB
	var osc7Buffer []byte
	var utf8Carry []byte

	// Filter control for injected OSC 7 config command (TCP 分包处理)
	isFilteringInit := true
	initTarget := []byte(` PROMPT_COMMAND='printf`) // 带前导空格防止 history 记录

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
				data := append(utf8Carry, buf[:n]...)
				utf8Carry = trimIncompleteUTF8(data)
				if len(utf8Carry) > 0 {
					data = data[:len(data)-len(utf8Carry)]
				}

				// 优先级一：isFilteringInit 逐行匹配，处理 TCP 分包
				if isFilteringInit {
					if idx := bytes.Index(data, initTarget); idx != -1 {
						// 找到目标前缀，定位行起始位置
						lineStart := idx
						for lineStart > 0 && data[lineStart-1] != '\n' {
							lineStart--
						}

						// 查找行结束位置（换行符）
						lineEnd := bytes.Index(data[idx:], []byte("\n"))
						if lineEnd != -1 {
							// 成功找到完整的行，切除并关闭过滤器
							lineEnd += idx + 1
							data = append(data[:lineStart], data[lineEnd:]...)
							isFilteringInit = false // 只过滤一次
						} else {
							// TCP 分包：匹配到了目标，但这一行还没传完（缺 \n）
							// 只发送 lineStart 之前的数据，lineStart 之后等待下一包
							data = data[:lineStart]
							// 保持 isFilteringInit = true，下一包继续处理
						}
					}
				}

				// 优先级二：osc7Buffer 容量限制，防止内存泄漏
				if !isFilteringInit {
					osc7Buffer = append(osc7Buffer, data...)
					if len(osc7Buffer) > osc7BufferMaxSize {
						keepLen := osc7BufferMaxSize / 2 // 保留最新 512KB
						newData := make([]byte, keepLen)
						copy(newData, osc7Buffer[len(osc7Buffer)-keepLen:])
						osc7Buffer = newData // 断开与老数组的引用，允许 GC 回收
						slog.Warn("osc7 buffer overflow, truncated", "session_id", conn.SessionID)
					}
					cwd := extractOSC7(&osc7Buffer)
					if cwd != "" {
						h.sendWSMessage(wsConn.WS(), ws.MsgCwd, "", ws.CwdPayload{
							Path: cwd,
						})
					}
				}

				if len(data) > 0 {
					data = filterBracketedPaste(data)
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

// filterBracketedPaste removes bracketed paste mode sequences from shell output.
// Handles complete sequences (ESC[?2004h/l with '?' prefix) and any resulting errors.
func filterBracketedPaste(data []byte) []byte {
	// Remove complete bracketed paste sequences: ESC[?2004h and ESC[?2004l
	// Note: modern terminals use ? prefix (e.g., \x1b[?2004h)
	data = bytes.ReplaceAll(data, []byte{0x1b, '[', '?', '2', '0', '0', '4', 'h'}, nil)
	data = bytes.ReplaceAll(data, []byte{0x1b, '[', '?', '2', '0', '0', '4', 'l'}, nil)

	// Also handle sequences without '?' (older terminal implementations)
	data = bytes.ReplaceAll(data, []byte{0x1b, '[', '2', '0', '0', '4', 'h'}, nil)
	data = bytes.ReplaceAll(data, []byte{0x1b, '[', '2', '0', '0', '4', 'l'}, nil)

	// Remove shell error output caused by broken bracketed paste handling
	// This happens when shell outputs the sequence incorrectly
	data = bytes.ReplaceAll(data, []byte("-bash: 2004h: command not found\n"), nil)
	data = bytes.ReplaceAll(data, []byte("-bash: 2004h: command not found\r\n"), nil)
	data = bytes.ReplaceAll(data, []byte("-bash: 2004l: command not found\n"), nil)
	data = bytes.ReplaceAll(data, []byte("-bash: 2004l: command not found\r\n"), nil)

	return data
}

// injectOSC7Config sets PROMPT_COMMAND for OSC 7 directory tracking.
func (h *WSHandler) injectOSC7Config(session *Session) {
	if session == nil || session.Shell == nil {
		return
	}

	osc7Cmd := ` PROMPT_COMMAND='printf "\033]7;file://%s%s\007" "` + "`hostname`" + `" "$PWD"'`
	session.Shell.Write([]byte(osc7Cmd + "\n"))
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

// handlePing measures the real round-trip latency to the remote SSH host by
// forwarding the heartbeat ping through the SSH connection, then replies with
// a pong. The frontend measures the full RTT (renderer→backend→SSH→backend→
// renderer), which equals the true end-to-end latency regardless of where the
// backend runs — fixing the desktop-mode case where a local backend made the
// old WS-only ping always read ~1ms.
//
// When the driver doesn't support remote ping (no Pinger) or the ping fails,
// it replies immediately so the frontend falls back to WS RTT measurement.
// Runs in its own goroutine to avoid blocking input processing.
func (h *WSHandler) handlePing(wsConn *websocket.Conn, session *Session) {
	session.mu.Lock()
	driver := session.Driver
	session.mu.Unlock()

	if driver == nil {
		h.sendWSMessage(wsConn, ws.MsgPong, "", nil)
		return
	}

	pinger, ok := driver.(protocol.Pinger)
	if !ok {
		h.sendWSMessage(wsConn, ws.MsgPong, "", nil)
		return
	}

	// Bound the ping so a degraded connection can't pile up goroutines across
	// heartbeat cycles (the frontend pings every 5s).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := pinger.Ping(ctx); err != nil {
		slog.Debug("ssh ping failed", "session_id", session.ID, "error", err)
	}
	// Reply regardless of success: the frontend computes RTT from the elapsed
	// wall-clock time, so a slow/failed ping is reflected as high latency
	// rather than a permanently stuck measurement.
	h.sendWSMessage(wsConn, ws.MsgPong, "", nil)
}
