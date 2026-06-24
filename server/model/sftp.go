package model

import "time"

// SftpEntry represents a file or directory entry. Field names use snake_case
// to match the frontend types/sftp.ts contract.
type SftpEntry struct {
	Name    string `json:"name"`               // base name without path
	Path    string `json:"path"`               // absolute POSIX path (no trailing slash)
	IsDir   bool   `json:"is_dir"`             // true for directories
	Size    int64  `json:"size"`               // bytes; 0 for directories
	ModTime string `json:"mod_time"`           // RFC 3339 timestamp
	Mode    string `json:"mode,omitempty"`     // Unix permission string e.g. "rwxr-xr-x" (optional)
}

// SftpTreeNode is a tree entry used by the recursive tree endpoint.
type SftpTreeNode struct {
	SftpEntry
	Children []SftpTreeNode `json:"children,omitempty"`
}

// SftpServer describes a connection target.
type SftpServer struct {
	ID       string `json:"id"`       // "local" or a profile ID
	Name     string `json:"name"`     // display name
	Host     string `json:"host"`     // hostname
	Port     int    `json:"port"`     // port; 0 for local
	Username string `json:"username"` // login user
}

// TransferTask represents an asynchronous file transfer.
type TransferTask struct {
	ID           string `json:"id"`                      // task ID
	FileName     string `json:"file_name"`               // file name
	Direction    string `json:"direction"`               // "upload" | "download"
	Size         int64  `json:"size"`                    // total bytes
	Transferred  int64  `json:"transferred"`             // bytes transferred
	Status       string `json:"status"`                  // queued | transferring | completed | failed | cancelled
	Speed        int64  `json:"speed"`                   // bytes/sec
	StartedAt    int64  `json:"started_at"`              // Unix milliseconds
	FinishedAt   *int64 `json:"finished_at,omitempty"`   // completion timestamp
	ErrorMessage string `json:"error_message,omitempty"` // failure reason
}

// --- Request / Response DTOs ---

type SftpCreateSessionRequest struct {
	ProfileID string `json:"profile_id"`
}

type SftpCreateSessionResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

type SftpSessionInfo struct {
	ID        string    `json:"id"`
	ProfileID string    `json:"profile_id"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type SftpListResponse struct {
	Path    string      `json:"path"`
	Entries []SftpEntry `json:"entries"`
}

type SftpTreeResponse struct {
	Path    string          `json:"path"`
	Entries []SftpTreeNode  `json:"entries"`
}

type SftpMkdirRequest struct {
	Path string `json:"path"`
}

type SftpRenameRequest struct {
	OldPath string `json:"old_path"`
	NewPath string `json:"new_path"`
}

type SftpDeleteRequest struct {
	Paths []string `json:"paths"`
}

type SftpDeleteResponse struct {
	Deleted int `json:"deleted"`
	Failed  int `json:"failed"`
}

type SftpDownloadRequest struct {
	Paths []string `json:"paths"`
}

type SftpDownloadResponse struct {
	Tasks       []TransferTask `json:"tasks"`
	DownloadURL string         `json:"download_url"`
}

type SftpUploadResponse struct {
	Tasks []TransferTask `json:"tasks"`
}

type SftpCancelTransferResponse struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}
