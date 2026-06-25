package handler

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

	// Resolve the conflict strategy. The legacy `overwrite` boolean is kept as
	// an alias for conflict_resolution=overwrite for backward compatibility.
	resolution := req.ConflictResolution
	if resolution == "" {
		if req.Overwrite {
			resolution = model.ConflictOverwrite
		} else {
			resolution = model.ConflictAsk
		}
	}

	// --- Pre-transfer conflict detection ---
	// For every source path, compute the destination path and check whether a
	// file already exists on the target. Collisions are reported back to the
	// caller when the strategy is "ask"; otherwise they are handled according
	// to the chosen strategy below.
	conflicts := make([]model.SftpConflictInfo, 0)
	for _, p := range cleanPaths {
		info, err := srcSession.Backend.Stat(r.Context(), p)
		if err != nil {
			// Missing source file: skip; the actual transfer will surface the
			// error if appropriate.
			continue
		}
		// Compute the destination path: files keep their name, directories
		// are archived as <dirname>.tar.gz on the target.
		var destPath string
		if info.IsDir {
			destPath = fileutil.JoinPath(destDir, dirArchiveName(p))
		} else {
			destPath = fileutil.JoinPath(destDir, info.Name)
		}
		if destInfo, err := tgtSession.Backend.Stat(r.Context(), destPath); err == nil && !destInfo.IsDir {
			conflicts = append(conflicts, model.SftpConflictInfo{
				SourcePath: p,
				DestPath:   destPath,
				SourceSize: info.Size,
				DestSize:   destInfo.Size,
			})
		}
	}

	// If conflicts exist and the caller asked to be prompted, return 409 with
	// the conflict list and DO NOT start a transfer.
	if len(conflicts) > 0 && resolution == model.ConflictAsk {
		writeJSON(w, http.StatusConflict, model.SftpTransferResponse{
			Conflicts: conflicts,
		})
		return
	}

	// Compute total size for progress tracking. For directories, walk the
	// tree to sum all file sizes (uncompressed) so progress is meaningful
	// during tar.gz archival. Skipped conflicts are excluded at transfer time.
	var totalSize int64
	for _, p := range cleanPaths {
		info, err := srcSession.Backend.Stat(r.Context(), p)
		if err != nil {
			continue
		}
		if info.IsDir {
			_ = fileutil.Walk(r.Context(), srcSession.Backend, p, func(_ string, wi fileutil.FileInfo) error {
				if !wi.IsDir {
					totalSize += wi.Size
				}
				return nil
			})
		} else {
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
			method := h.tryDirectTransfer(ctx, entry, srcSession, tgtSession, cleanPaths, destDir, resolution)
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
		h.doStreamRelay(ctx, entry, srcSession, tgtSession, cleanPaths, destDir, resolution)
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
	paths []string, destDir string, resolution model.ConflictResolution,
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

	// Transfer each file/dir via scp concurrently (skip-on-error).
	var totalTransferred atomic.Int64
	stopReporter := h.transfers.startProgressReporter(ctx, task, &totalTransferred)

	var failuresMu sync.Mutex
	var failures []string
	var successCount int

	var wg sync.WaitGroup
	for _, p := range paths {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			// Acquire concurrency slot
			h.transfers.sem <- struct{}{}
			defer func() { <-h.transfers.sem }()

			if err := h.directTransferOne(ctx, execDriver, src, sshPrefix, remoteTarget, p, destDir, resolution, &totalTransferred); err != nil {
				failuresMu.Lock()
				failures = append(failures, p+": "+err.Error())
				failuresMu.Unlock()
				slog.Warn("direct scp failed (skip-on-error)", "path", p, "error", err)
				return
			}
			failuresMu.Lock()
			successCount++
			failuresMu.Unlock()
		}(p)
	}
	wg.Wait()

	stopReporter()

	h.transfers.mu.Lock()
	task.Transferred = task.Size
	task.Speed = 0
	h.transfers.mu.Unlock()

	if successCount == 0 {
		// Every path failed — fall back to stream relay.
		slog.Info("direct transfer failed for all paths, falling back to relay",
			"task", task.ID, "failures", len(failures))
		return directFail
	}

	task.Status = "completed"
	nowPtr := time.Now().UnixMilli()
	task.FinishedAt = &nowPtr
	h.transfers.broadcastComplete(task)

	if len(failures) > 0 {
		h.transfers.mu.Lock()
		task.ErrorMessage = fmt.Sprintf("%d/%d paths failed: %s", len(failures), len(paths), strings.Join(failures, "; "))
		h.transfers.mu.Unlock()
	}
	slog.Info("direct transfer completed", "task", task.ID, "success", successCount, "failures", len(failures))
	return directOK
}

// directTransferOne transfers a single path via scp on the source host.
// Directories use `scp -r`. Conflict resolution is applied per-path. On
// success the path's size is added to the shared atomic counter.
func (h *SftpHandler) directTransferOne(
	ctx context.Context, execDriver sftpdriver.ExecProvider,
	src *SftpSession, sshPrefix, remoteTarget, p, destDir string,
	resolution model.ConflictResolution,
	totalTransferred *atomic.Int64,
) error {
	fileName := fileutil.BaseName(p)
	destPath := destDir + "/" + fileName

	// Stat source to determine if it's a directory (scp -r needed).
	srcInfo, srcErr := src.Backend.Stat(ctx, p)
	isDir := srcErr == nil && srcInfo.IsDir

	scpFlag := ""
	if isDir {
		scpFlag = "-r "
	}

	switch resolution {
	case model.ConflictOverwrite:
		rmFlag := "-f"
		if isDir {
			rmFlag = "-rf"
		}
		rmCmd := fmt.Sprintf("%sssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 %s 'rm %s %q'",
			sshPrefix, remoteTarget, rmFlag, destPath)
		execDriver.Exec(ctx, rmCmd) // ignore errors
	case model.ConflictSkip:
		testCmd := fmt.Sprintf("%sssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 %s 'test -e %q'",
			sshPrefix, remoteTarget, destPath)
		if _, _, exitCode, _ := execDriver.Exec(ctx, testCmd); exitCode == 0 {
			// Exists → skip; count size as "transferred".
			totalTransferred.Add(pathSize(ctx, src.Backend, p, srcInfo))
			return nil
		}
	case model.ConflictRename:
		base, ext := fileutil.SplitExt(fileName)
		for i := 1; ; i++ {
			candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
			candPath := destDir + "/" + candidate
			testCmd := fmt.Sprintf("%sssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 %s 'test -e %q'",
				sshPrefix, remoteTarget, candPath)
			if _, _, exitCode, _ := execDriver.Exec(ctx, testCmd); exitCode != 0 {
				destPath = candPath
				break
			}
			if i > 9999 {
				break
			}
		}
	}

	cmd := fmt.Sprintf("%sscp %s-o StrictHostKeyChecking=no -o ConnectTimeout=10 %q %s:%q",
		sshPrefix, scpFlag, p, remoteTarget, destPath)

	_, stderr, exitCode, err := execDriver.Exec(ctx, cmd)
	if err != nil || exitCode != 0 {
		return fmt.Errorf("scp exit %d: %s", exitCode, string(stderr))
	}

	totalTransferred.Add(pathSize(ctx, src.Backend, p, srcInfo))
	return nil
}

// doStreamRelay pipes data from source FileBackend to target FileBackend.
// Files are streamed directly (no temp file); directories are archived as
// .tar.gz (see transferDirAsTarGz). Multiple paths transfer CONCURRENTLY
// (up to TransferManager.maxConcurrent), and a failure on one path does NOT
// abort the others (skip-on-error): failed paths are recorded in
// task.ErrorMessage and the task still completes if at least one path
// succeeded. A single progress-reporter goroutine broadcasts aggregate
// progress every 500ms.
func (h *SftpHandler) doStreamRelay(
	ctx context.Context, entry *transferEntry,
	src, tgt *SftpSession,
	paths []string, destDir string, resolution model.ConflictResolution,
) {
	task := entry.task
	task.Status = "transferring"

	// Ensure dest dir exists on target
	if err := tgt.Backend.MkdirP(ctx, destDir); err != nil {
		h.transfers.failTask(entry, "mkdir dest: "+err.Error())
		return
	}

	var totalTransferred atomic.Int64
	stopReporter := h.transfers.startProgressReporter(ctx, task, &totalTransferred)

	var failuresMu sync.Mutex
	var failures []string

	var wg sync.WaitGroup
	for _, p := range paths {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			// Acquire concurrency slot
			h.transfers.sem <- struct{}{}
			defer func() { <-h.transfers.sem }()

			if err := h.transferOneStreamRelay(ctx, entry, src, tgt, p, destDir, resolution, &totalTransferred); err != nil {
				failuresMu.Lock()
				failures = append(failures, p+": "+err.Error())
				failuresMu.Unlock()
				slog.Warn("stream relay item failed (skip-on-error)", "path", p, "error", err)
			}
		}(p)
	}
	wg.Wait()

	stopReporter()

	// Final status
	h.transfers.mu.Lock()
	task.Transferred = task.Size
	task.Speed = 0
	h.transfers.mu.Unlock()

	if len(failures) > 0 && len(failures) == len(paths) {
		// Every path failed
		h.transfers.failTask(entry, fmt.Sprintf("all %d paths failed: %s", len(failures), strings.Join(failures, "; ")))
		return
	}

	h.transfers.completeTask(entry)
	if len(failures) > 0 {
		// Partial success — record which paths failed but keep "completed".
		h.transfers.mu.Lock()
		task.ErrorMessage = fmt.Sprintf("%d/%d paths failed: %s", len(failures), len(paths), strings.Join(failures, "; "))
		h.transfers.mu.Unlock()
	}
	slog.Info("stream relay transfer completed", "task", task.ID, "failures", len(failures), "total", len(paths))
}

// transferOneStreamRelay transfers a single path (file or directory) from src
// to tgt. Directories are archived as .tar.gz; files are piped directly with
// no temp file. Progress bytes are added to the shared atomic counter; the
// caller's progress reporter handles broadcasting.
func (h *SftpHandler) transferOneStreamRelay(
	ctx context.Context, entry *transferEntry,
	src, tgt *SftpSession,
	p, destDir string, resolution model.ConflictResolution,
	totalTransferred *atomic.Int64,
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	info, err := src.Backend.Stat(ctx, p)
	if err != nil {
		return fmt.Errorf("stat source: %w", err)
	}

	if info.IsDir {
		return h.transferDirAsTarGz(ctx, entry, src, tgt, p, destDir, resolution, totalTransferred)
	}

	fileName := info.Name
	if fileName == "" {
		fileName = fileutil.BaseName(p)
	}
	destPath := fileutil.JoinPath(destDir, fileName)

	// Resolve conflicts according to the chosen strategy.
	if _, statErr := tgt.Backend.Stat(ctx, destPath); statErr == nil {
		switch resolution {
		case model.ConflictOverwrite:
			if err := tgt.Backend.Remove(ctx, destPath); err != nil {
				return fmt.Errorf("overwrite dest %s: %w", destPath, err)
			}
		case model.ConflictRename:
			renamed, err := fileutil.AutoRename(ctx, tgt.Backend, destPath)
			if err != nil {
				return fmt.Errorf("rename dest %s: %w", destPath, err)
			}
			slog.Info("conflict resolved by rename", "original", destPath, "renamed", renamed)
			destPath = renamed
		case model.ConflictSkip:
			slog.Info("conflict resolved by skip", "path", destPath)
			totalTransferred.Add(info.Size)
			return nil
		default:
			// "ask" short-circuits at the handler level; treat as skip.
			return nil
		}
	}

	rc, err := src.Backend.OpenRead(ctx, p)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}

	wc, err := tgt.Backend.OpenWrite(ctx, destPath)
	if err != nil {
		rc.Close()
		return fmt.Errorf("open dest %s: %w", destPath, err)
	}

	// Stream copy with progress. Direct pipe (no temp file), so each byte
	// read = byte transferred.
	buf := make([]byte, 64*1024)
	for {
		select {
		case <-ctx.Done():
			rc.Close()
			wc.Close()
			return ctx.Err()
		default:
		}

		n, rerr := rc.Read(buf)
		if n > 0 {
			if _, werr := wc.Write(buf[:n]); werr != nil {
				rc.Close()
				wc.Close()
				return fmt.Errorf("write dest: %w", werr)
			}
			totalTransferred.Add(int64(n))
		}
		if rerr != nil {
			rc.Close()
			wc.Close()
			if rerr == io.EOF {
				return nil
			}
			return fmt.Errorf("read source: %w", rerr)
		}
	}
}

// dirArchiveName returns the .tar.gz file name for a source directory path.
// "/var/log/nginx" → "nginx.tar.gz"; "/" → "archive.tar.gz".
func dirArchiveName(srcDir string) string {
	name := fileutil.BaseName(srcDir)
	if name == "" || name == "/" {
		name = "archive"
	}
	return name + ".tar.gz"
}

// transferDirAsTarGz compresses a source directory into a .tar.gz temp file
// (phase 1) and then uploads it to the target backend as a single
// <dirname>.tar.gz file (phase 2). The temp file is cleaned up on exit.
//
// Progress is tracked as uncompressed bytes read from the source during
// archival (phase 1). The upload phase (phase 2) does not add to the
// transferred count since those bytes were already accounted for; the final
// task.Transferred is set to task.Size by the caller (doStreamRelay).
//
// Temp files use the "sshx-tx-" prefix and are cleaned up by the TransferManager
// sweep loop (orphan cleanup after 1 hour) if the process dies mid-transfer.
func (h *SftpHandler) transferDirAsTarGz(
	ctx context.Context, entry *transferEntry,
	src, tgt *SftpSession,
	srcDir, destDir string, resolution model.ConflictResolution,
	totalTransferred *atomic.Int64,
) error {
	task := entry.task

	dirName := fileutil.BaseName(srcDir)
	if dirName == "" || dirName == "/" {
		dirName = "archive"
	}
	destPath := fileutil.JoinPath(destDir, dirName+".tar.gz")

	// Resolve conflicts (same logic as single-file transfer).
	if _, err := tgt.Backend.Stat(ctx, destPath); err == nil {
		switch resolution {
		case model.ConflictOverwrite:
			if err := tgt.Backend.Remove(ctx, destPath); err != nil {
				return fmt.Errorf("overwrite dest %s: %w", destPath, err)
			}
		case model.ConflictRename:
			renamed, err := fileutil.AutoRename(ctx, tgt.Backend, destPath)
			if err != nil {
				return fmt.Errorf("rename dest %s: %w", destPath, err)
			}
			slog.Info("dir conflict resolved by rename", "original", destPath, "renamed", renamed)
			destPath = renamed
		case model.ConflictSkip:
			slog.Info("dir conflict resolved by skip", "path", destPath)
			return nil
		default:
			return nil
		}
	}

	// Ensure dest dir exists.
	if err := tgt.Backend.MkdirP(ctx, destDir); err != nil {
		return fmt.Errorf("mkdir dest: %w", err)
	}

	// --- Phase 1: Create tar.gz temp file from source directory ---
	tmpFile := filepath.Join(h.transfers.tmpDir, "sshx-tx-"+task.ID+".tar.gz")
	defer os.Remove(tmpFile) // best-effort cleanup

	f, err := os.Create(tmpFile)
	if err != nil {
		return fmt.Errorf("create temp tar.gz: %w", err)
	}
	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)

	walkErr := fileutil.Walk(ctx, src.Backend, srcDir, func(walkPath string, info fileutil.FileInfo) error {
		// Compute archive-relative path (rooted at dirName).
		relPath := strings.TrimPrefix(walkPath, srcDir)
		relPath = strings.TrimPrefix(relPath, "/")
		archivePath := dirName
		if relPath != "" {
			archivePath = dirName + "/" + relPath
		}

		if info.IsDir {
			return tw.WriteHeader(&tar.Header{
				Name:     archivePath + "/",
				Mode:     0o755,
				Typeflag: tar.TypeDir,
				ModTime:  info.ModTime,
			})
		}

		if err := tw.WriteHeader(&tar.Header{
			Name:     archivePath,
			Mode:     0o644,
			Size:     info.Size,
			Typeflag: tar.TypeReg,
			ModTime:  info.ModTime,
		}); err != nil {
			return err
		}

		rc, err := src.Backend.OpenRead(ctx, walkPath)
		if err != nil {
			return err
		}
		n, err := io.Copy(tw, rc)
		rc.Close()
		if err != nil {
			return err
		}
		totalTransferred.Add(n)
		return nil
	})

	if cerr := tw.Close(); cerr != nil && walkErr == nil {
		walkErr = cerr
	}
	if cerr := gw.Close(); cerr != nil && walkErr == nil {
		walkErr = cerr
	}
	if cerr := f.Close(); cerr != nil && walkErr == nil {
		walkErr = cerr
	}
	if walkErr != nil {
		return fmt.Errorf("create tar.gz: %w", walkErr)
	}

	// --- Phase 2: Upload tar.gz to target ---
	f, err = os.Open(tmpFile)
	if err != nil {
		return fmt.Errorf("open temp tar.gz: %w", err)
	}
	defer f.Close()

	wc, err := tgt.Backend.OpenWrite(ctx, destPath)
	if err != nil {
		return fmt.Errorf("open dest %s: %w", destPath, err)
	}

	uploadBuf := make([]byte, 64*1024)
	for {
		select {
		case <-ctx.Done():
			wc.Close()
			return ctx.Err()
		default:
		}
		n, rerr := f.Read(uploadBuf)
		if n > 0 {
			if _, werr := wc.Write(uploadBuf[:n]); werr != nil {
				wc.Close()
				return fmt.Errorf("write dest: %w", werr)
			}
		}
		if rerr != nil {
			wc.Close()
			if rerr == io.EOF {
				break
			}
			return fmt.Errorf("read temp: %w", rerr)
		}
	}

	slog.Info("directory transferred as tar.gz",
		"src", srcDir, "dest", destPath, "transferred", totalTransferred.Load())
	return nil
}

// pathSize returns the total uncompressed size of a path. For files this is
// the file size; for directories it is the recursive sum of all file sizes.
func pathSize(ctx context.Context, be fileutil.FileBackend, p string, info fileutil.FileInfo) int64 {
	if !info.IsDir {
		return info.Size
	}
	var total int64
	_ = fileutil.Walk(ctx, be, p, func(_ string, wi fileutil.FileInfo) error {
		if !wi.IsDir {
			total += wi.Size
		}
		return nil
	})
	return total
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
