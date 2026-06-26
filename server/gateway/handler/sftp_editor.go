package handler

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yuweinfo/sshx/fileutil"
	"github.com/yuweinfo/sshx/model"
)

// --- SFTP built-in editor handlers ---
//
// GET  /api/sftp/sessions/{id}/file?path=...  → read file as text (guarded)
// PUT  /api/sftp/sessions/{id}/file?path=...  → write file (optimistic-lock)
//
// Guards on read (in order):
//  1. Size: Stat first; > MaxEditableFileSize → 413 FILE_TOO_LARGE
//  2. Binary: sniff first BinarySniffSize bytes for NUL → 415 BINARY_FILE
//  3. Encoding: must be valid UTF-8 → 415 UNSUPPORTED_ENCODING
//
// Write uses an optimistic lock on ModTime: if the file changed between the
// client's read and write, return 409 FILE_MODIFIED so the user can reload
// instead of silently clobbering someone else's edit.

// MaxEditableFileSize/BinarySniffSize live in model/sftp.go so the frontend
// contract shares a single source of truth.

// ReadFile handles GET /api/sftp/sessions/{id}/file?path=...
func (h *SftpHandler) ReadFile(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}
	cleanPath := fileutil.CleanPath(p)

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	info, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		h.handleFileErr(w, err)
		return
	}
	if info.IsDir {
		writeError(w, http.StatusBadRequest, "IS_DIRECTORY", "cannot edit a directory")
		return
	}

	// Guard 1: size
	if info.Size > model.MaxEditableFileSize {
		writeError(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			"文件过大，无法在编辑器中打开（上限 10MB），请下载后本地编辑")
		return
	}

	rc, err := backend.OpenRead(ctx, cleanPath)
	if err != nil {
		h.handleFileErr(w, err)
		return
	}
	defer rc.Close()

	// Read up to MaxEditableFileSize. We already verified size <= limit, so a
	// single ReadAll is bounded; but cap defensively in case the file grew
	// between Stat and OpenRead.
	buf := make([]byte, 0, info.Size+1)
	tmp := make([]byte, 64*1024)
	for {
		n, rerr := rc.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if int64(len(buf)) > model.MaxEditableFileSize {
				writeError(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
					"文件在读取过程中变大超过 10MB 上限")
				return
			}
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				break
			}
			h.handleFileErr(w, rerr)
			return
		}
	}

	// Guard 2: binary sniff (NUL byte in first 8KB)
	sniffLen := len(buf)
	if sniffLen > model.BinarySniffSize {
		sniffLen = model.BinarySniffSize
	}
	if bytes.IndexByte(buf[:sniffLen], 0) >= 0 {
		writeError(w, http.StatusUnsupportedMediaType, "BINARY_FILE",
			"该文件为二进制文件，无法在文本编辑器中打开")
		return
	}

	// Guard 3: UTF-8 validity
	if !utf8.Valid(buf) {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_ENCODING",
			"文件不是有效的 UTF-8 编码（当前仅支持 UTF-8）")
		return
	}

	content := string(buf)
	lineEnding := detectLineEnding(buf)
	// Normalize CRLF → LF for the editor; the original ending is preserved on
	// write via the LineEnding field.
	if lineEnding == model.LineEndingCRLF {
		content = strings.ReplaceAll(content, "\r\n", "\n")
	}

	readOnly := !isWritable(info.Mode)

	h.auditSftp(session.ProfileID, "sftp_read_file", "path="+cleanPath)
	writeJSON(w, http.StatusOK, model.SftpFileReadResponse{
		Path:       cleanPath,
		Content:    content,
		Size:       info.Size,
		ModTime:    info.ModTime.Format(time.RFC3339Nano),
		Language:   detectLanguage(cleanPath),
		LineEnding: lineEnding,
		ReadOnly:   readOnly,
	})
}

// WriteFile handles PUT /api/sftp/sessions/{id}/file?path=...
func (h *SftpHandler) WriteFile(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}
	cleanPath := fileutil.CleanPath(p)

	var req model.SftpFileWriteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()

	// Optimistic lock: verify the file hasn't changed since the client read it.
	// If the file does not exist, treat this as a create operation.
	current, err := backend.Stat(ctx, cleanPath)
	isNewFile := errors.Is(err, fileutil.ErrNotFound)
	if err != nil && !isNewFile {
		h.handleFileErr(w, err)
		return
	}
	if !isNewFile {
		if current.IsDir {
			writeError(w, http.StatusBadRequest, "IS_DIRECTORY", "cannot write a directory")
			return
		}
		if req.ExpectedModTime != "" {
			expected, perr := time.Parse(time.RFC3339Nano, req.ExpectedModTime)
			if perr != nil {
				writeError(w, http.StatusBadRequest, "INVALID_MOD_TIME", "expected_mod_time is not a valid RFC 3339 timestamp")
				return
			}
			if !current.ModTime.Equal(expected) {
				writeError(w, http.StatusConflict, "FILE_MODIFIED",
					"文件在编辑期间已被其他进程修改，请重新加载以避免覆盖")
				return
			}
		}
	}

	// Apply line ending policy. Default to LF if unspecified.
	ending := req.LineEnding
	if ending == "" {
		ending = model.LineEndingLF
	}
	content := req.Content
	if ending == model.LineEndingCRLF {
		// Convert standalone LF (not already part of CRLF) to CRLF. Since the
		// editor normalizes to LF on read, content here is pure LF.
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}

	data := []byte(content)

	// Enforce the size limit on write too, so a paste-flood cannot blow up
	// the editor session on next reload.
	if int64(len(data)) > model.MaxEditableFileSize {
		writeError(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			"保存后文件大小超过 10MB 上限")
		return
	}

	wc, err := backend.OpenWrite(ctx, cleanPath)
	if err != nil {
		h.handleFileErr(w, err)
		return
	}
	if _, err := wc.Write(data); err != nil {
		wc.Close()
		h.handleFileErr(w, err)
		return
	}
	if err := wc.Close(); err != nil {
		h.handleFileErr(w, err)
		return
	}

	// Re-stat to obtain the new ModTime (the optimistic-lock token for the
	// next save). Some SFTP servers update mtime with sub-second precision,
	// so we use RFC 3339Nano.
	updated, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		// Write succeeded but re-stat failed.
		if isNewFile {
			// For new files, use current time as fallback.
			writeJSON(w, http.StatusOK, model.SftpFileWriteResponse{
				Path:    cleanPath,
				Size:    int64(len(data)),
				ModTime: time.Now().Format(time.RFC3339Nano),
			})
		} else {
			// For existing files, fall back to current's mtime.
			writeJSON(w, http.StatusOK, model.SftpFileWriteResponse{
				Path:    cleanPath,
				Size:    int64(len(data)),
				ModTime: current.ModTime.Format(time.RFC3339Nano),
			})
		}
		return
	}

	action := "sftp_write_file"
	if isNewFile {
		action = "sftp_create_file"
	}
	h.auditSftp(session.ProfileID, action, "path="+cleanPath+" size="+itoa64(len(data)))
	writeJSON(w, http.StatusOK, model.SftpFileWriteResponse{
		Path:    cleanPath,
		Size:    updated.Size,
		ModTime: updated.ModTime.Format(time.RFC3339Nano),
	})
}

// itoa64 is a local strconv.FormatInt replacement to avoid an extra import.
func itoa64(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
