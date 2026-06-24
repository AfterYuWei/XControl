package handler

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/fileutil"
	"github.com/yuweinfo/sshx/model"
	sftpdriver "github.com/yuweinfo/sshx/protocol/sftp"
)

// CrossSessionTransfer performs a file transfer between two SFTP sessions.
// Strategy (cross-platform, no dependency on source/target OS):
//  1. Direct: execute scp/ssh on the source host pushing to the target host.
//     Requires OpenSSH client + auth (key or sshpass) on the source host.
//  2. Stream relay (fallback): backend opens both FileBackends and pipes
//     data directly from source reader to target writer via io.Copy, with
//     NO temp file. Works for any OS combination including local↔remote.
func (h *SftpHandler) CrossSessionTransfer(w http.ResponseWriter, r *http.Request) {
	var req model.SftpTransferRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.SourceSessionID == "" || req.TargetSessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "source_session_id and target_session_id are required")
		return
	}
	if len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "paths is required")
		return
	}

	srcSession := h.getSession(req.SourceSessionID)
	tgtSession := h.getSession(req.TargetSessionID)
	if srcSession == nil || tgtSession == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}
	if srcSession.Status != "connected" || tgtSession.Status != "connected" {
		writeError(w, http.StatusConflict, "SESSION_NOT_CONNECTED", "both sessions must be connected")
		return
	}

	cleanPaths := make([]string, len(req.Paths))
	for i, p := range req.Paths {
		cleanPaths[i] = fileutil.CleanPath(p)
	}
	destDir := fileutil.CleanPath(req.DestDir)

	// Compute total size for progress tracking
	var totalSize int64
	for _, p := range cleanPaths {
		info, err := srcSession.Backend.Stat(r.Context(), p)
		if err == nil && !info.IsDir {
			totalSize += info.Size
		}
	}

	taskID := fmt.Sprintf("tx-%d-%s", time.Now().Unix(), uuid.New().String()[:6])
	now := time.Now().UnixMilli()
	task := &model.TransferTask{
		ID:        taskID,
		FileName:  transferName(cleanPaths),
		Direction: "transfer",
		Size:      totalSize,
		Status:    "transferring",
		StartedAt: now,
	}

	ctx, cancel := context.WithCancel(context.Background())
	entry := &transferEntry{
		task:    task,
		cancel:  cancel,
		session: req.SourceSessionID,
	}
	h.transfers.mu.Lock()
	h.transfers.tasks[taskID] = entry
	h.transfers.mu.Unlock()

	go func() {
		// Phase 1: Try direct scp on source host (only for remote→remote)
		if srcSession.ProfileID != "local" && tgtSession.ProfileID != "local" {
			method := h.tryDirectTransfer(ctx, entry, srcSession, tgtSession, cleanPaths, destDir, req.Overwrite)
			if method == directOK {
				return
			}
			slog.Info("direct transfer unavailable, using stream relay",
				"task", taskID, "reason", method)
			// Reset progress for relay
			h.transfers.mu.Lock()
			task.Status = "transferring"
			task.Transferred = 0
			task.ErrorMessage = ""
			h.transfers.mu.Unlock()
		}
		// Phase 2: Stream relay (no temp file, cross-platform)
		h.doStreamRelay(ctx, entry, srcSession, tgtSession, cleanPaths, destDir, req.Overwrite)
	}()

	writeJSON(w, http.StatusAccepted, model.SftpTransferResponse{
		TaskID: taskID,
		Method: "auto",
		Tasks:  []model.TransferTask{*task},
	})
}

type directResult int

const (
	directOK      directResult = iota // success
	directSkip                        // not applicable (no exec, local, etc.)
	directFail                        // attempted but failed
)

// tryDirectTransfer attempts to execute scp on the source host to push files
// directly to the target host. Cross-platform detection:
//   - Checks for OpenSSH scp availability via `command -v scp`
//   - Uses sshpass for password auth if available; otherwise tries key-based
//     auth via ssh-agent forwarding (not supported here, falls back)
//
// Returns directOK on success, directSkip if not applicable, directFail on error.
func (h *SftpHandler) tryDirectTransfer(
	ctx context.Context, entry *transferEntry,
	src, tgt *SftpSession,
	paths []string, destDir string, overwrite bool,
) directResult {
	task := entry.task

	execDriver, ok := getExecProvider(src)
	if !ok {
		return directSkip
	}

	// Detect scp availability on source host (works on Linux/macOS/Windows+OpenSSH)
	out, _, _, err := execDriver.Exec(ctx, "command -v scp")
	if err != nil || len(strings.TrimSpace(string(out))) == 0 {
		slog.Info("direct transfer skipped: scp not found on source host")
		return directSkip
	}

	// Detect sshpass for password-based auth
	hasSshpass := false
	out2, _, _, _ := execDriver.Exec(ctx, "command -v sshpass")
	if len(strings.TrimSpace(string(out2))) > 0 {
		hasSshpass = true
	}

	// Build the auth prefix and remote target
	var sshPrefix, remoteTarget string
	if hasSshpass && tgt.Password != "" {
		sshPrefix = fmt.Sprintf("sshpass -p %q ", tgt.Password)
		remoteTarget = fmt.Sprintf("%s@%s", tgt.Username, tgt.Host)
	} else if tgt.PrivKey != "" {
		// Key-based: write temp key on source, use it
		// This is complex and risky; skip and fall back to relay
		slog.Info("direct transfer skipped: target uses key auth (not supported in direct mode)")
		return directSkip
	} else {
		slog.Info("direct transfer skipped: no password and no sshpass")
		return directSkip
	}

	// Ensure dest dir exists on target via ssh mkdir
	mkdirCmd := fmt.Sprintf("%sssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 %s 'mkdir -p %q'",
		sshPrefix, remoteTarget, destDir)
	if _, stderr, exitCode, err := execDriver.Exec(ctx, mkdirCmd); err != nil || exitCode != 0 {
		slog.Warn("direct mkdir failed", "stderr", string(stderr), "error", err)
		return directFail
	}

	// Transfer each file via scp
	for _, p := range paths {
		fileName := fileutil.BaseName(p)
		destPath := destDir + "/" + fileName

		// Remove existing if overwrite
		if overwrite {
			rmCmd := fmt.Sprintf("%sssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 %s 'rm -f %q'",
				sshPrefix, remoteTarget, destPath)
			execDriver.Exec(ctx, rmCmd) // ignore errors
		}

		cmd := fmt.Sprintf("%sscp -o StrictHostKeyChecking=no -o ConnectTimeout=10 %q %s:%q",
			sshPrefix, p, remoteTarget, destPath)

		_, stderr, exitCode, err := execDriver.Exec(ctx, cmd)
		if err != nil || exitCode != 0 {
			slog.Warn("direct scp failed",
				"path", p, "exitCode", exitCode,
				"stderr", string(stderr), "error", err)
			return directFail
		}

		// Update progress (direct has no granular progress; jump per file)
		if info, err := src.Backend.Stat(ctx, p); err == nil {
			h.transfers.mu.Lock()
			task.Transferred += info.Size
			h.transfers.mu.Unlock()
			h.transfers.broadcastProgressToSession(task)
		}
	}

	task.Status = "completed"
	task.Transferred = task.Size
	nowPtr := time.Now().UnixMilli()
	task.FinishedAt = &nowPtr
	h.transfers.broadcastComplete(task)
	slog.Info("direct transfer completed", "task", task.ID)
	return directOK
}

// doStreamRelay pipes data directly from source FileBackend to target
// FileBackend using io.Copy, with NO temp file. This is cross-platform (works
// for local↔local, local↔remote, remote↔remote) and avoids disk I/O.
func (h *SftpHandler) doStreamRelay(
	ctx context.Context, entry *transferEntry,
	src, tgt *SftpSession,
	paths []string, destDir string, overwrite bool,
) {
	task := entry.task
	task.Status = "transferring"

	// Ensure dest dir exists on target
	if err := tgt.Backend.MkdirP(ctx, destDir); err != nil {
		h.transfers.failTask(entry, "mkdir dest: "+err.Error())
		return
	}

	var totalTransferred int64
	buf := make([]byte, 64*1024)

	for _, p := range paths {
		select {
		case <-ctx.Done():
			h.transfers.failTask(entry, "cancelled")
			return
		default:
		}

		info, err := src.Backend.Stat(ctx, p)
		if err != nil {
			h.transfers.failTask(entry, "stat source "+p+": "+err.Error())
			return
		}
		if info.IsDir {
			// TODO: recursive directory transfer via fileutil.Walk
			slog.Warn("skipping directory in stream relay (not yet supported)", "path", p)
			continue
		}

		fileName := info.Name
		if fileName == "" {
			fileName = fileutil.BaseName(p)
		}
		destPath := fileutil.JoinPath(destDir, fileName)

		// Overwrite check
		if !overwrite {
			if _, err := tgt.Backend.Stat(ctx, destPath); err == nil {
				h.transfers.failTask(entry, "file exists: "+destPath)
				return
			}
		}

		// Open source for reading
		rc, err := src.Backend.OpenRead(ctx, p)
		if err != nil {
			h.transfers.failTask(entry, "open source "+p+": "+err.Error())
			return
		}

		// Open target for writing
		wc, err := tgt.Backend.OpenWrite(ctx, destPath)
		if err != nil {
			rc.Close()
			h.transfers.failTask(entry, "open dest "+destPath+": "+err.Error())
			return
		}

		// Stream copy with progress. Since it's a direct pipe (no temp file),
		// progress is real-time: each byte read = byte transferred.
		lastReport := time.Now()
		var lastTransferred int64

		for {
			select {
			case <-ctx.Done():
				rc.Close()
				wc.Close()
				h.transfers.failTask(entry, "cancelled")
				return
			default:
			}

			n, rerr := rc.Read(buf)
			if n > 0 {
				if _, werr := wc.Write(buf[:n]); werr != nil {
					rc.Close()
					wc.Close()
					h.transfers.failTask(entry, "write dest: "+werr.Error())
					return
				}
				totalTransferred += int64(n)

				// Report progress every 500ms
				if time.Since(lastReport) >= 500*time.Millisecond {
					elapsed := time.Since(lastReport).Seconds()
					speed := int64(0)
					if elapsed > 0 {
						speed = int64(float64(totalTransferred-lastTransferred) / elapsed)
					}
					lastTransferred = totalTransferred
					lastReport = time.Now()

					h.transfers.mu.Lock()
					task.Transferred = totalTransferred
					task.Speed = speed
					h.transfers.mu.Unlock()
					h.transfers.broadcastProgressToSession(task)
				}
			}
			if rerr != nil {
				rc.Close()
				wc.Close()
				if rerr == io.EOF {
					break
				}
				h.transfers.failTask(entry, "read source: "+rerr.Error())
				return
			}
		}
	}

	task.Transferred = task.Size
	h.transfers.completeTask(entry)
	slog.Info("stream relay transfer completed", "task", task.ID)
}

// getExecProvider extracts the ExecProvider interface from a session's driver.
func getExecProvider(session *SftpSession) (sftpdriver.ExecProvider, bool) {
	if session.Driver == nil {
		return nil, false
	}
	exec, ok := session.Driver.(sftpdriver.ExecProvider)
	if !ok {
		return nil, false
	}
	return exec, true
}

// transferName generates a display name for the transfer task.
func transferName(paths []string) string {
	if len(paths) == 0 {
		return "transfer"
	}
	if len(paths) == 1 {
		return fileutil.BaseName(paths[0])
	}
	return fmt.Sprintf("%d 个文件", len(paths))
}

// getSession retrieves a session by ID (read-locked).
func (h *SftpHandler) getSession(id string) *SftpSession {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[id]
}

// Ensure runtime import is used for future OS-specific logic.
var _ = runtime.GOOS
