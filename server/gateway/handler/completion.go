package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/yuweinfo/xcontrol/protocol"
	"github.com/yuweinfo/xcontrol/ws"
)

// completeTimeout is the hard timeout for dynamic autocomplete queries.
const completeTimeout = 400 * time.Millisecond

// handleComplete executes a read-only remote command for dynamic completion.
func (h *WSHandler) handleComplete(wsConn *websocket.Conn, session *Session, raw json.RawMessage) {
	var req ws.CompleteRequestPayload
	if err := json.Unmarshal(raw, &req); err != nil {
		slog.Warn("complete_request parse error", "error", err)
		return
	}
	if req.RequestID == "" || req.Script == "" {
		return
	}

	executor, ok := session.Driver.(protocol.CommandExecutor)
	if !ok {
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Error:     "driver does not support command execution",
			ExitCode:  -1,
		})
		return
	}

	cmd := req.Script
	if req.Cwd != "" {
		cmd = "cd " + shellQuote(req.Cwd) + " && " + req.Script
	}

	ctx, cancel := context.WithTimeout(context.Background(), completeTimeout)
	defer cancel()

	sendResult := func(stdout []byte, exitCode int, err error) {
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Output:    string(stdout),
			Error:     errMsg,
			ExitCode:  exitCode,
		})
	}

	if executorWithContext, ok := session.Driver.(protocol.ContextCommandExecutor); ok {
		stdout, _, exitCode, err := executorWithContext.ExecContext(ctx, cmd)
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			slog.Debug("complete_request timeout", "request_id", req.RequestID, "script", req.Script, "timeout", completeTimeout)
			h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
				RequestID: req.RequestID,
				Error:     "timeout",
				ExitCode:  -1,
			})
			return
		}
		sendResult(stdout, exitCode, err)
		return
	}

	type execResult struct {
		stdout   []byte
		exitCode int
		err      error
	}

	resultCh := make(chan execResult, 1)
	go func() {
		stdout, _, exitCode, err := executor.Exec(cmd)
		resultCh <- execResult{stdout: stdout, exitCode: exitCode, err: err}
	}()

	select {
	case r := <-resultCh:
		sendResult(r.stdout, r.exitCode, r.err)
	case <-ctx.Done():
		slog.Debug("complete_request timeout", "request_id", req.RequestID, "script", req.Script, "timeout", completeTimeout)
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Error:     "timeout",
			ExitCode:  -1,
		})
	}
}

// shellQuote wraps a path in POSIX-safe single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
