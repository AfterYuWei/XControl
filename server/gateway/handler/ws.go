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

	// Wait for session to be ready
	session := h.waitForSession(sessionID, sessionReadyTimeout)
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

		case ws.MsgCompleteRequest:
			// 异步处理:避免 400ms 超时阻塞 readPump 读取后续 input/resize
			// coder/websocket 的 Conn.Write 线程安全,可并发写响应
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
			// set session.Status = "error" with a reason. The driver's watch
			// goroutine (client.Wait) and the shell's Wait goroutine both
			// detect the same connection close, but the driver callback may
			// lag by a few microseconds. 50ms is imperceptible to users yet
			// ample for the callback to complete.
			select {
			case <-time.After(50 * time.Millisecond):
			case <-ctx.Done():
				return
			}
			reason, message := session.DisconnectInfo()
			if reason != "" {
				// Abnormal disconnect: SSH connection died (remote shutdown,
				// keepalive timeout, network error). Notify frontend so it can
				// show a status dialog and trigger auto-reconnect.
				h.sendWSMessage(wsConn.WS(), ws.MsgDisconnect, "", ws.DisconnectPayload{
					Reason:  reason,
					Message: message,
				})
			} else {
				// Normal shell exit (user typed "exit" or remote shell ended).
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
				// Carry over incomplete UTF-8 trailing bytes from previous read
				// to prevent splitting multi-byte characters at buffer boundaries
				data := append(utf8Carry, buf[:n]...)
				utf8Carry = trimIncompleteUTF8(data)
				if len(utf8Carry) > 0 {
					data = data[:len(data)-len(utf8Carry)]
				}

				// Surgical filter for injected OSC 7 config command
				// Handles network packet fragmentation gracefully
				if isFilteringInit {
					initFilterBuf = append(initFilterBuf, data...)
					totalInitSeen += len(data)

					if firstIdx := bytes.Index(initFilterBuf, initTarget); firstIdx != -1 {
						lastIdx := bytes.LastIndex(initFilterBuf, initTarget)
						slog.Debug("init filter: target found", "first_idx", firstIdx, "last_idx", lastIdx, "buf_len", len(initFilterBuf), "total_seen", totalInitSeen)
						// Find the start of the line containing the FIRST target (search backwards for \n)
						lineStart := firstIdx
						for lineStart > 0 && initFilterBuf[lineStart-1] != '\n' {
							lineStart--
						}
						// Find the end of the line containing the LAST target (search forwards for \n, include it).
						// The injected command contains __osc7_cwd 4 times (func def, zsh hook, bash pattern,
						// bash assignment) and may span multiple lines due to terminal width wrapping.
						endIdx := bytes.Index(initFilterBuf[lastIdx:], []byte("\n"))

						if endIdx != -1 {
							lineEnd := lastIdx + endIdx + 1 // +1 to include the \n
							// Remove all lines containing __osc7_cwd occurrences in one operation.
							// This is robust against ANSI color codes and shell prompt prefixes
							// because we remove whole lines, not just the exact target bytes.
							cleanedData := append([]byte{}, initFilterBuf[:lineStart]...)
							cleanedData = append(cleanedData, initFilterBuf[lineEnd:]...)
							data = cleanedData
							isFilteringInit = false // Done, disable filter
							initFilterBuf = nil     // Release memory
							slog.Debug("init filter: command echo lines removed", "line_start", lineStart, "line_end", lineEnd, "removed_bytes", lineEnd-lineStart, "data_len", len(data))
						} else {
							// Found target but no newline after the last occurrence yet (truncated by network)
							// Send data before line start, hold the rest
							data = append([]byte{}, initFilterBuf[:lineStart]...)
							initFilterBuf = append([]byte{}, initFilterBuf[lineStart:]...)
						}
					} else {
						// Command not seen yet — target may be split across reads.
						// Hold back the last len(initTarget)-1 bytes to avoid sending
						// a partial target to the frontend.
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
							// Buffer is smaller than keepLen, hold everything
							data = nil
						}

						// Safety fallback: if we've seen a lot of data without finding
						// the command, the shell probably didn't echo it (or the command
						// was lost). Disable the filter and release any held-back data.
						if totalInitSeen > 10240 {
							slog.Debug("init filter: safety fallback triggered, disabling filter", "total_seen", totalInitSeen, "buf_len", len(initFilterBuf))
							isFilteringInit = false
							data = append(data, initFilterBuf...)
							initFilterBuf = nil
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

// trimIncompleteUTF8 returns trailing bytes from buf that form an incomplete
// UTF-8 sequence. These bytes should be prepended to the next read to avoid
// splitting multi-byte characters at buffer boundaries.
func trimIncompleteUTF8(buf []byte) []byte {
	if len(buf) == 0 {
		return nil
	}
	// Scan backwards up to utf8.UTFMax (4) bytes to find a valid rune boundary
	for i := 1; i <= utf8.UTFMax && i <= len(buf); i++ {
		r, size := utf8.DecodeRune(buf[len(buf)-i:])
		if r != utf8.RuneError || size != 1 {
			// Valid rune found at this position — everything after it is incomplete
			if i > 1 {
				return buf[len(buf)-(i-1):]
			}
			return nil
		}
	}
	// All trailing bytes (up to 4) are invalid/incomplete
	n := utf8.UTFMax
	if n > len(buf) {
		n = len(buf)
	}
	return buf[len(buf)-n:]
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
	slog.Debug("osc7 config command injected", "cmd_len", len(osc7Cmd)+1)

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
