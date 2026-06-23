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
