package ws

import "encoding/json"

type MessageType string

const (
	MsgInput   MessageType = "input"
	MsgOutput  MessageType = "output"
	MsgResize  MessageType = "resize"
	MsgExit    MessageType = "exit"
	MsgError   MessageType = "error"
	MsgPing    MessageType = "ping"
	MsgPong    MessageType = "pong"
	MsgAuth    MessageType = "auth"
	MsgMeta    MessageType = "metadata"

	// Terminal current working directory (detected via OSC 7)
	MsgCwd MessageType = "cwd"

	// Terminal autocomplete dynamic query (只读远程 exec,不影响 PTY)
	MsgCompleteRequest  MessageType = "complete_request"
	MsgCompleteResponse MessageType = "complete_response"

	// SFTP transfer progress messages
	MsgTransferProgress MessageType = "transfer_progress"
	MsgTransferComplete MessageType = "transfer_complete"
	MsgTransferFailed   MessageType = "transfer_failed"
	MsgSftpSessionStatus MessageType = "sftp_session_status"
)

type Message struct {
	Type    MessageType     `json:"type"`
	Data    string          `json:"data,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type ResizePayload struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type ExitPayload struct {
	Code int `json:"code"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type MetaPayload struct {
	SessionID string `json:"session_id"`
	Host      string `json:"host"`
	Username  string `json:"username"`
	Protocol  string `json:"protocol"`
}

type CwdPayload struct {
	Path string `json:"path"`
}

// --- Autocomplete dynamic query payloads ---

// CompleteRequestPayload 客户端请求执行只读脚本获取动态补全候选
type CompleteRequestPayload struct {
	RequestID string `json:"request_id"`
	Script    string `json:"script"` // 只读脚本,如 "git branch --list"
	Cwd       string `json:"cwd"`    // 可选,OSC7 追踪到的当前工作目录
}

// CompleteResponsePayload 服务端返回脚本执行结果
type CompleteResponsePayload struct {
	RequestID string `json:"request_id"`
	Output    string `json:"output"`     // 脚本 stdout
	Error     string `json:"error"`      // 错误信息(超时/执行失败)
	ExitCode  int    `json:"exit_code"`  // 退出码,-1 表示未执行/超时
}

// --- SFTP transfer payloads ---

type TransferProgressPayload struct {
	TaskID      string `json:"task_id"`
	Transferred int64  `json:"transferred"`
	Size        int64  `json:"size"`
	Speed       int64  `json:"speed"`
	Status      string `json:"status"`
}

type TransferCompletePayload struct {
	TaskID     string `json:"task_id"`
	Status     string `json:"status"`
	FinishedAt int64  `json:"finished_at"`
}

type TransferFailedPayload struct {
	TaskID       string `json:"task_id"`
	Status       string `json:"status"`
	ErrorMessage string `json:"error_message"`
}

type SftpSessionStatusPayload struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

func ParseMessage(data []byte) (*Message, error) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

func MarshalMessage(msg *Message) ([]byte, error) {
	return json.Marshal(msg)
}
