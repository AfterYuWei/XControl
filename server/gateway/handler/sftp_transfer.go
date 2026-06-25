package handler

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/fileutil"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/ws"
)

// TransferManager manages asynchronous file transfer tasks. It tracks task
// state in memory (no persistence, per design decision) and pushes progress
// updates via the SFTP WebSocket hub.
//
// --- Temp file lifecycle (sshx-tx / sshx-dl) ---
//
// Temp files are created under os.TempDir() with one of two prefixes:
//
//   - "sshx-dl-<taskID>"     — download staging (single file or .zip)
//   - "sshx-tx-<taskID>.tar.gz" — cross-session directory archive (tar.gz)
//
// Normal flow: temp files are deleted immediately after use (download served,
// archive uploaded). Abnormal flow (process crash, kill -9): temp files
// become orphans and are cleaned by sweepLoop.
//
// sweepLoop runs every 10 minutes and removes any temp file whose ModTime is
// older than 1 hour. For large file/directory transfers that are actively
// in progress, this is safe because each write updates the file's ModTime,
// keeping it "fresh". The only risk is a completed download temp file that
// the client never fetches — it lingers for up to 1 hour before cleanup.
type TransferManager struct {
	tasks         map[string]*transferEntry
	mu            sync.RWMutex
	hub           *ws.SftpHub
	maxConcurrent int
	sem           chan struct{}

	// Temp directory for download staging (zip assembly etc.)
	tmpDir string
}

// transferEntry wraps a TransferTask with a cancel function and cleanup hook.
type transferEntry struct {
	task    *model.TransferTask
	cancel  context.CancelFunc
	cleanup func() // called when task is cancelled/failed/completed-and-served
	session string
}

func NewTransferManager(hub *ws.SftpHub) *TransferManager {
	tm := &TransferManager{
		tasks:         make(map[string]*transferEntry),
		hub:           hub,
		maxConcurrent: 5,
		sem:           make(chan struct{}, 5),
		tmpDir:        os.TempDir(),
	}
	// Start a background sweeper to clean up orphaned temp files every 10 min
	go tm.sweepLoop()
	return tm
}

// --- Upload ---

// StartUpload processes multipart file uploads. Each file becomes a separate
// task. Files are first saved to temp storage (parsed from multipart), then
// streamed to the destination backend in background goroutines.
func (tm *TransferManager) StartUpload(session *SftpSession, files []*multipart.FileHeader, destDir string, overwrite bool) []model.TransferTask {
	tasks := make([]model.TransferTask, 0, len(files))
	cleanDest := fileutil.CleanPath(destDir)

	for _, fh := range files {
		taskID := tm.genTaskID(fh.Filename)
		now := time.Now().UnixMilli()
		task := &model.TransferTask{
			ID:        taskID,
			FileName:  fh.Filename,
			Direction: "upload",
			Size:      fh.Size,
			Status:    "queued",
			StartedAt: now,
		}

		ctx, cancel := context.WithCancel(context.Background())
		entry := &transferEntry{
			task:    task,
			cancel:  cancel,
			session: session.ID,
		}

		tm.mu.Lock()
		tm.tasks[taskID] = entry
		tm.mu.Unlock()

		// Open the uploaded file (multipart stores large files to disk automatically)
		src, err := fh.Open()
		if err != nil {
			task.Status = "failed"
			task.ErrorMessage = "failed to open uploaded file: " + err.Error()
			nowPtr := time.Now().UnixMilli()
			task.FinishedAt = &nowPtr
			tm.broadcastFailed(task)
			tasks = append(tasks, *task)
			continue
		}

		go tm.doUpload(ctx, entry, session, src, cleanDest, fh.Filename, overwrite)
		tasks = append(tasks, *task)
	}

	return tasks
}

func (tm *TransferManager) doUpload(ctx context.Context, entry *transferEntry, session *SftpSession, src io.ReadCloser, destDir, fileName string, overwrite bool) {
	defer src.Close()

	// Acquire concurrency slot
	tm.sem <- struct{}{}
	defer func() { <-tm.sem }()

	task := entry.task
	task.Status = "transferring"
	destPath := fileutil.JoinPath(destDir, fileName)

	// Check overwrite
	if !overwrite {
		if _, err := session.Backend.Stat(ctx, destPath); err == nil {
			task.Status = "failed"
			task.ErrorMessage = "file already exists: " + destPath
			nowPtr := time.Now().UnixMilli()
			task.FinishedAt = &nowPtr
			tm.broadcastFailed(task)
			return
		}
	}

	wc, err := session.Backend.OpenWrite(ctx, destPath)
	if err != nil {
		tm.failTask(entry, "open dest file: "+err.Error())
		return
	}

	// Stream with progress tracking
	if err := tm.copyWithProgress(ctx, entry, src, wc); err != nil {
		wc.Close()
		tm.failTask(entry, "upload copy: "+err.Error())
		return
	}
	if err := wc.Close(); err != nil {
		tm.failTask(entry, "close dest file: "+err.Error())
		return
	}

	task.Transferred = task.Size
	tm.completeTask(entry)
	slog.Info("upload completed", "task", task.ID, "file", fileName, "size", task.Size)
}

// --- Download ---

// StartDownload creates download tasks for the given paths. If multiple paths
// are provided, a single zip task is created. Otherwise a single-file task.
func (tm *TransferManager) StartDownload(session *SftpSession, paths []string) ([]model.TransferTask, string) {
	if len(paths) == 0 {
		return nil, ""
	}

	cleanPaths := make([]string, len(paths))
	for i, p := range paths {
		cleanPaths[i] = fileutil.CleanPath(p)
	}

	// Single file: direct download task
	if len(paths) == 1 {
		p := cleanPaths[0]
		info, err := session.Backend.Stat(context.Background(), p)
		if err != nil {
			return nil, ""
		}
		fileName := info.Name
		if fileName == "" {
			fileName = filepath.Base(p)
		}

		taskID := tm.genTaskID(fileName)
		now := time.Now().UnixMilli()
		task := &model.TransferTask{
			ID:        taskID,
			FileName:  fileName,
			Direction: "download",
			Size:      info.Size,
			Status:    "queued",
			StartedAt: now,
		}

		ctx, cancel := context.WithCancel(context.Background())
		entry := &transferEntry{
			task:    task,
			cancel:  cancel,
			session: session.ID,
		}

		// Temp file for staging
		tmpFile := filepath.Join(tm.tmpDir, "sshx-dl-"+taskID)
		entry.cleanup = func() {
			os.Remove(tmpFile)
		}

		tm.mu.Lock()
		tm.tasks[taskID] = entry
		tm.mu.Unlock()

		go tm.doDownloadSingle(ctx, entry, session, p, tmpFile)

		return []model.TransferTask{*task}, "/api/sftp/transfers/" + taskID + "/file"
	}

	// Multiple files: zip download
	taskID := tm.genTaskID("download.zip")
	now := time.Now().UnixMilli()
	task := &model.TransferTask{
		ID:        taskID,
		FileName:  "download.zip",
		Direction: "download",
		Size:      0, // unknown until zipped
		Status:    "queued",
		StartedAt: now,
	}

	ctx, cancel := context.WithCancel(context.Background())
	tmpFile := filepath.Join(tm.tmpDir, "sshx-dl-"+taskID+".zip")
	entry := &transferEntry{
		task:    task,
		cancel:  cancel,
		session: session.ID,
		cleanup: func() {
			os.Remove(tmpFile)
		},
	}

	tm.mu.Lock()
	tm.tasks[taskID] = entry
	tm.mu.Unlock()

	go tm.doDownloadZip(ctx, entry, session, cleanPaths, tmpFile)

	return []model.TransferTask{*task}, "/api/sftp/transfers/" + taskID + "/file"
}

func (tm *TransferManager) doDownloadSingle(ctx context.Context, entry *transferEntry, session *SftpSession, srcPath, tmpFile string) {
	tm.sem <- struct{}{}
	defer func() { <-tm.sem }()

	task := entry.task
	task.Status = "transferring"

	rc, err := session.Backend.OpenRead(ctx, srcPath)
	if err != nil {
		tm.failTask(entry, "open src file: "+err.Error())
		return
	}
	defer rc.Close()

	f, err := os.Create(tmpFile)
	if err != nil {
		tm.failTask(entry, "create temp file: "+err.Error())
		return
	}
	defer f.Close()

	if err := tm.copyWithProgress(ctx, entry, rc, f); err != nil {
		tm.failTask(entry, "download copy: "+err.Error())
		return
	}

	task.Transferred = task.Size
	tm.completeTask(entry)
	slog.Info("download completed", "task", task.ID, "file", task.FileName)
}

func (tm *TransferManager) doDownloadZip(ctx context.Context, entry *transferEntry, session *SftpSession, srcPaths []string, tmpFile string) {
	tm.sem <- struct{}{}
	defer func() { <-tm.sem }()

	task := entry.task
	task.Status = "transferring"

	// First pass: stat all files to compute total size
	var totalSize int64
	type fileItem struct {
		path string
		info fileutil.FileInfo
	}
	items := make([]fileItem, 0, len(srcPaths))
	for _, p := range srcPaths {
		info, err := session.Backend.Stat(ctx, p)
		if err != nil {
			slog.Warn("download stat failed", "path", p, "error", err)
			continue
		}
		if !info.IsDir {
			totalSize += info.Size
		}
		items = append(items, fileItem{path: p, info: info})
	}
	task.Size = totalSize

	f, err := os.Create(tmpFile)
	if err != nil {
		tm.failTask(entry, "create temp zip: "+err.Error())
		return
	}
	defer f.Close()

	zw := zip.NewWriter(f)

	for _, item := range items {
		if item.info.IsDir {
			// Add directory entry
			zipPath := strings.TrimPrefix(item.path, "/")
			if !strings.HasSuffix(zipPath, "/") {
				zipPath += "/"
			}
			if _, err := zw.Create(zipPath); err != nil {
				tm.failTask(entry, "create zip dir entry: "+err.Error())
				zw.Close()
				return
			}
			continue
		}

		rc, err := session.Backend.OpenRead(ctx, item.path)
		if err != nil {
			slog.Warn("download open failed", "path", item.path, "error", err)
			continue
		}

		zipPath := strings.TrimPrefix(item.path, "/")
		w, err := zw.Create(zipPath)
		if err != nil {
			rc.Close()
			tm.failTask(entry, "create zip entry: "+err.Error())
			zw.Close()
			return
		}

		if err := tm.copyWithProgress(ctx, entry, rc, w); err != nil {
			rc.Close()
			tm.failTask(entry, "zip copy: "+err.Error())
			zw.Close()
			return
		}
		rc.Close()
	}

	if err := zw.Close(); err != nil {
		tm.failTask(entry, "close zip: "+err.Error())
		return
	}

	task.Transferred = task.Size
	tm.completeTask(entry)
	slog.Info("zip download completed", "task", task.ID, "files", len(items))
}

// ServeDownloadFile streams the downloaded temp file to the HTTP response.
// The temp file is cleaned up after serving (normal flow) or on error.
func (tm *TransferManager) ServeDownloadFile(w http.ResponseWriter, r *http.Request, taskID string) {
	tm.mu.RLock()
	entry, ok := tm.tasks[taskID]
	tm.mu.RUnlock()
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "transfer task not found")
		return
	}

	if entry.task.Status != "completed" {
		writeError(w, http.StatusConflict, "NOT_READY", "transfer is "+entry.task.Status)
		return
	}

	// Determine temp file path
	ext := ""
	if strings.HasSuffix(entry.task.FileName, ".zip") {
		ext = ".zip"
	}
	tmpFile := filepath.Join(tm.tmpDir, "sshx-dl-"+taskID+ext)

	f, err := os.Open(tmpFile)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "download file expired or cleaned up")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, entry.task.FileName))
	w.Header().Set("Content-Type", "application/octet-stream")

	// Stream the file
	if _, err := io.Copy(w, f); err != nil {
		slog.Warn("download serve failed", "task", taskID, "error", err)
	}

	// Normal-flow cleanup: remove temp file after serving
	// (done in a goroutine to not block the response)
	go func() {
		os.Remove(tmpFile)
		// Optionally remove the task entry
		tm.mu.Lock()
		delete(tm.tasks, taskID)
		tm.mu.Unlock()
	}()
}

// --- Task queries ---

func (tm *TransferManager) List(sessionID, status string) []model.TransferTask {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	result := make([]model.TransferTask, 0, len(tm.tasks))
	for _, e := range tm.tasks {
		if sessionID != "" && e.session != sessionID {
			continue
		}
		if status != "" && e.task.Status != status {
			continue
		}
		result = append(result, *e.task)
	}
	return result
}

func (tm *TransferManager) Get(taskID string) (*model.TransferTask, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	entry, ok := tm.tasks[taskID]
	if !ok {
		return nil, false
	}
	return entry.task, true
}

// --- Cancel / cleanup ---

func (tm *TransferManager) Cancel(taskID string) (*model.TransferTask, error) {
	tm.mu.Lock()
	entry, ok := tm.tasks[taskID]
	if !ok {
		tm.mu.Unlock()
		return nil, fmt.Errorf("task not found")
	}
	tm.mu.Unlock()

	entry.cancel()

	task := entry.task
	if task.Status == "completed" || task.Status == "failed" || task.Status == "cancelled" {
		return task, nil
	}

	task.Status = "cancelled"
	nowPtr := time.Now().UnixMilli()
	task.FinishedAt = &nowPtr

	// Run cleanup (remove temp files)
	if entry.cleanup != nil {
		entry.cleanup()
	}

	tm.broadcastComplete(task)
	return task, nil
}

func (tm *TransferManager) CancelBySession(sessionID string) {
	tm.mu.RLock()
	ids := make([]string, 0)
	for id, e := range tm.tasks {
		if e.session == sessionID {
			ids = append(ids, id)
		}
	}
	tm.mu.RUnlock()

	for _, id := range ids {
		tm.Cancel(id)
	}
}

func (tm *TransferManager) ClearCompleted() {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for id, e := range tm.tasks {
		if e.task.Status == "completed" || e.task.Status == "failed" || e.task.Status == "cancelled" {
			if e.cleanup != nil {
				e.cleanup()
			}
			delete(tm.tasks, id)
		}
	}
}

// --- Upload handler entry point ---

func (h *SftpHandler) Upload(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}

	// Parse multipart form: 32MB in memory, rest to disk
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_FORM", err.Error())
		return
	}

	destDir := r.FormValue("dest_dir")
	if destDir == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "dest_dir is required")
		return
	}
	overwrite := r.FormValue("overwrite") == "true"

	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "no files provided")
		return
	}

	// Ensure dest directory exists
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := backend.MkdirP(ctx, fileutil.CleanPath(destDir)); err != nil {
		writeError(w, http.StatusInternalServerError, "MKDIR_FAILED", err.Error())
		return
	}

	tasks := h.transfers.StartUpload(session, files, destDir, overwrite)

	// Audit
	for _, t := range tasks {
		h.auditSftp(session.ProfileID, "sftp_upload", "dest="+destDir+"/"+t.FileName+" size="+fmt.Sprintf("%d", t.Size))
	}

	writeJSON(w, http.StatusAccepted, model.SftpUploadResponse{Tasks: tasks})
}

func (h *SftpHandler) Download(w http.ResponseWriter, r *http.Request) {
	session, _, ok := h.resolveSession(w, r)
	if !ok {
		return
	}

	var req model.SftpDownloadRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "paths is required")
		return
	}

	tasks, downloadURL := h.transfers.StartDownload(session, req.Paths)

	// Audit
	for _, t := range tasks {
		h.auditSftp(session.ProfileID, "sftp_download", "file="+t.FileName+" size="+fmt.Sprintf("%d", t.Size))
	}

	writeJSON(w, http.StatusAccepted, model.SftpDownloadResponse{
		Tasks:       tasks,
		DownloadURL: downloadURL,
	})
}

func (h *SftpHandler) ListTransfers(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	status := r.URL.Query().Get("status")
	tasks := h.transfers.List(sessionID, status)
	if tasks == nil {
		tasks = []model.TransferTask{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (h *SftpHandler) CancelTransfer(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("task_id")
	task, err := h.transfers.Cancel(taskID)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "transfer task not found")
		return
	}
	writeJSON(w, http.StatusOK, model.SftpCancelTransferResponse{ID: task.ID, Status: task.Status})
}

func (h *SftpHandler) ClearCompletedTransfers(w http.ResponseWriter, r *http.Request) {
	h.transfers.ClearCompleted()
	w.WriteHeader(http.StatusNoContent)
}

func (h *SftpHandler) ServeDownloadFile(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("task_id")
	h.transfers.ServeDownloadFile(w, r, taskID)
}

// --- Internal helpers ---

func (tm *TransferManager) genTaskID(fileName string) string {
	return fmt.Sprintf("tx-%d-%s-%s", time.Now().Unix(), uuid.New().String()[:6], fileName)
}

func (tm *TransferManager) copyWithProgress(ctx context.Context, entry *transferEntry, src io.Reader, dst io.Writer) error {
	buf := make([]byte, 64*1024)
	var transferred int64
	lastReport := time.Now()
	var lastBytes int64

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			transferred += int64(n)
			entry.task.Transferred = transferred

			// Report progress every 500ms
			if time.Since(lastReport) >= 500*time.Millisecond {
				elapsed := time.Since(lastReport).Seconds()
				if elapsed > 0 {
					entry.task.Speed = int64(float64(transferred-lastBytes) / elapsed)
				}
				lastBytes = transferred
				lastReport = time.Now()
				tm.broadcastProgressToSession(entry.task)
			}
		}
		if err != nil {
			if err == io.EOF {
				// Final progress report
				entry.task.Transferred = entry.task.Size
				entry.task.Speed = 0
				tm.broadcastProgressToSession(entry.task)
				return nil
			}
			return err
		}
	}
}

func (tm *TransferManager) completeTask(entry *transferEntry) {
	task := entry.task
	task.Status = "completed"
	nowPtr := time.Now().UnixMilli()
	task.FinishedAt = &nowPtr
	task.Speed = 0
	tm.broadcastComplete(task)
}

func (tm *TransferManager) failTask(entry *transferEntry, msg string) {
	task := entry.task
	task.Status = "failed"
	task.ErrorMessage = msg
	nowPtr := time.Now().UnixMilli()
	task.FinishedAt = &nowPtr
	task.Speed = 0

	// Abnormal-interruption cleanup
	if entry.cleanup != nil {
		entry.cleanup()
	}

	tm.broadcastFailed(task)
	slog.Error("transfer failed", "task", task.ID, "error", msg)
}

func (tm *TransferManager) broadcastProgress(task *model.TransferTask) {
	tm.hub.BroadcastJSON("", ws.MsgTransferProgress, ws.TransferProgressPayload{
		TaskID:      task.ID,
		Transferred: task.Transferred,
		Size:        task.Size,
		Speed:       task.Speed,
		Status:      task.Status,
	})
}

func (tm *TransferManager) broadcastComplete(task *model.TransferTask) {
	// Find session for this task
	sessionID := ""
	tm.mu.RLock()
	if e, ok := tm.tasks[task.ID]; ok {
		sessionID = e.session
	}
	tm.mu.RUnlock()

	tm.hub.BroadcastJSON(sessionID, ws.MsgTransferComplete, ws.TransferCompletePayload{
		TaskID:     task.ID,
		Status:     task.Status,
		FinishedAt: derefInt64(task.FinishedAt),
	})
}

func (tm *TransferManager) broadcastFailed(task *model.TransferTask) {
	sessionID := ""
	tm.mu.RLock()
	if e, ok := tm.tasks[task.ID]; ok {
		sessionID = e.session
	}
	tm.mu.RUnlock()

	tm.hub.BroadcastJSON(sessionID, ws.MsgTransferFailed, ws.TransferFailedPayload{
		TaskID:       task.ID,
		Status:       task.Status,
		ErrorMessage: task.ErrorMessage,
	})
}

// startProgressReporter launches a background goroutine that broadcasts
// aggregate transfer progress every 500ms using a shared atomic counter. This
// is used by concurrent cross-session transfers where multiple goroutines
// update the same counter; the single reporter avoids per-goroutine speed
// miscalculation and reduces lock contention. The returned stop function must
// be called when the transfer completes (it closes the done channel).
func (tm *TransferManager) startProgressReporter(ctx context.Context, task *model.TransferTask, total *atomic.Int64) (stop func()) {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		var last int64
		lastReport := time.Now()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				cur := total.Load()
				elapsed := time.Since(lastReport).Seconds()
				speed := int64(0)
				if elapsed > 0 {
					speed = int64(float64(cur-last) / elapsed)
				}
				last = cur
				lastReport = time.Now()
				tm.mu.Lock()
				task.Transferred = cur
				task.Speed = speed
				tm.mu.Unlock()
				tm.broadcastProgressToSession(task)
			}
		}
	}()
	return func() { close(done) }
}

// broadcastProgressToSession sends a progress update to the WebSocket
// connection associated with the task's session.
func (tm *TransferManager) broadcastProgressToSession(task *model.TransferTask) {
	sessionID := ""
	tm.mu.RLock()
	if e, ok := tm.tasks[task.ID]; ok {
		sessionID = e.session
	}
	tm.mu.RUnlock()

	tm.hub.BroadcastJSON(sessionID, ws.MsgTransferProgress, ws.TransferProgressPayload{
		TaskID:      task.ID,
		Transferred: task.Transferred,
		Size:        task.Size,
		Speed:       task.Speed,
		Status:      task.Status,
	})
}

// sweepLoop periodically cleans up orphaned temp files (abnormal interruption
// safety net: e.g. server crashed mid-transfer, temp files left behind).
func (tm *TransferManager) sweepLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		entries, err := os.ReadDir(tm.tmpDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), "sshx-dl-") && !strings.HasPrefix(e.Name(), "sshx-tx-") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			// Remove temp files older than 1 hour
			if time.Since(info.ModTime()) > time.Hour {
				os.Remove(filepath.Join(tm.tmpDir, e.Name()))
				slog.Info("sweeper removed orphaned temp file", "file", e.Name())
			}
		}
	}
}

func derefInt64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
