package model

// --- Server management session ---

type ServerSessionRequest struct {
	ProfileID string `json:"profile_id"`
}

type ServerSessionResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

// --- Server info (static, fetched once after connection) ---

type ServerInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Kernel        string `json:"kernel"`
	Arch          string `json:"arch"`
	Uptime        string `json:"uptime"`
	LoadAvg       string `json:"load_avg"`        // "0.00 / 0.01 / 0.00"
	LoadAvgDetail string `json:"load_avg_detail"` // raw: "0.00 0.01 0.00 1/354 308603"
	CPUs          int    `json:"cpus"`
}

// --- File listing ---
// Uses existing SftpEntry and SftpListResponse from sftp.go for unified format.

// --- System metrics (pushed via WebSocket every N seconds) ---

type ServerMetrics struct {
	CPU        float64 `json:"cpu"`         // 0-100
	MemUsed    int64   `json:"mem_used"`    // bytes
	MemTotal   int64   `json:"mem_total"`   // bytes
	MemPercent float64 `json:"mem_percent"` // 0-100
	DiskUsed   int64   `json:"disk_used"`   // bytes
	DiskTotal  int64   `json:"disk_total"`  // bytes
	DiskPercent float64 `json:"disk_percent"` // 0-100
	NetRx      int64   `json:"net_rx"`      // bytes/sec
	NetTx      int64   `json:"net_tx"`      // bytes/sec
	Timestamp  int64   `json:"timestamp"`   // Unix ms
}

// --- WebSocket message types for server detail ---

const (
	MsgServerMetrics    = "metrics"
	MsgServerInfo       = "info"
	MsgSubscribeMetrics = "subscribe_metrics"
	MsgPing             = "ping"
	MsgPong             = "pong"
	MsgError            = "error"
)

// ServerWSError is sent when the server encounters an error.
type ServerWSError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
