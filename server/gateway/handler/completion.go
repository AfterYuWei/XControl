package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/yuweinfo/xcontrol/protocol"
	"github.com/yuweinfo/xcontrol/ws"
)

// completeTimeout 动态补全查询的硬超时
// 超时后直接返回 error,丢弃该次查询,不阻塞用户输入
const completeTimeout = 400 * time.Millisecond

// handleComplete 处理客户端发来的 complete_request
// 在独立非交互 SSH 会话执行只读脚本,不影响 PTY
func (h *WSHandler) handleComplete(wsConn *websocket.Conn, session *Session, raw json.RawMessage) {
	var req ws.CompleteRequestPayload
	if err := json.Unmarshal(raw, &req); err != nil {
		slog.Warn("complete_request parse error", "error", err)
		return
	}
	if req.RequestID == "" || req.Script == "" {
		return
	}

	// 检查 driver 是否实现 CommandExecutor
	executor, ok := session.Driver.(protocol.CommandExecutor)
	if !ok {
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Error:     "driver does not support command execution",
			ExitCode:  -1,
		})
		return
	}

	// 拼接 cwd:若提供则前置 cd,单引号转义防注入
	cmd := req.Script
	if req.Cwd != "" {
		escaped := shellQuote(req.Cwd)
		cmd = "cd " + escaped + " && " + req.Script
	}

	// Exec 是同步阻塞调用,用 goroutine + select 实现超时
	// 超时后 goroutine 会继续运行直到命令完成(只读命令通常很快),响应已丢弃
	type execResult struct {
		stdout   []byte
		stderr   []byte
		exitCode int
		err      error
	}
	resultCh := make(chan execResult, 1)
	go func() {
		stdout, stderr, exitCode, err := executor.Exec(cmd)
		resultCh <- execResult{stdout, stderr, exitCode, err}
	}()

	select {
	case r := <-resultCh:
		// 正常完成
		errMsg := ""
		if r.err != nil {
			errMsg = r.err.Error()
		}
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Output:    string(r.stdout),
			Error:     errMsg,
			ExitCode:  r.exitCode,
		})
	case <-time.After(completeTimeout):
		// 超时:返回 error,丢弃结果(后续 goroutine 完成后写入 channel 会被 GC)
		slog.Debug("complete_request timeout", "request_id", req.RequestID, "script", req.Script, "timeout", completeTimeout)
		h.sendWSMessage(wsConn, ws.MsgCompleteResponse, "", ws.CompleteResponsePayload{
			RequestID: req.RequestID,
			Error:     "timeout",
			ExitCode:  -1,
		})
	case <-context.Background().Done():
		// 不会触发,占位防止 lint
	}
}

// shellQuote 用 POSIX shell 安全引号包裹路径,防止 cwd 注入
// 规则:用单引号包裹,内部单引号替换为 '\''
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
