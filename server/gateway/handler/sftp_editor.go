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
	current, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		h.handleFileErr(w, err)
		return
	}
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
		// Write succeeded; fall back to current's mtime.
		writeJSON(w, http.StatusOK, model.SftpFileWriteResponse{
			Path:    cleanPath,
			Size:    int64(len(data)),
			ModTime: current.ModTime.Format(time.RFC3339Nano),
		})
		return
	}

	h.auditSftp(session.ProfileID, "sftp_write_file", "path="+cleanPath+" size="+itoa64(len(data)))
	writeJSON(w, http.StatusOK, model.SftpFileWriteResponse{
		Path:    cleanPath,
		Size:    updated.Size,
		ModTime: updated.ModTime.Format(time.RFC3339Nano),
	})
}

// --- helpers ---

// detectLineEnding inspects the leading bytes and returns "crlf" when \r\n
// makes up a meaningful share (>30%) of newlines, otherwise "lf".
func detectLineEnding(data []byte) model.LineEnding {
	if len(data) == 0 {
		return model.LineEndingLF
	}
	crlf := bytes.Count(data, []byte("\r\n"))
	lf := bytes.Count(data, []byte("\n"))
	if lf == 0 {
		return model.LineEndingLF
	}
	if crlf*100/lf >= 30 {
		return model.LineEndingCRLF
	}
	return model.LineEndingLF
}

// isWritable reports whether a permission-string (as produced by
// FileBackend.Stat().Mode, e.g. "rwxr-xr-x") grants the owner write bit.
// The owner-write bit is the 2nd character of the 9-char rwx triplet.
func isWritable(modeStr string) bool {
	// modeStr looks like "rw-r--r--" or "-rw-r--r--" (leading type char).
	s := strings.TrimSpace(modeStr)
	// Strip a leading type char (e.g. '-' for regular file).
	if len(s) == 10 {
		s = s[1:]
	}
	if len(s) < 9 {
		// Unknown/empty mode → be permissive (let the write attempt surface
		// the real permission error).
		return true
	}
	return s[1] == 'w'
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

// detectLanguage maps a POSIX file path to a Monaco language id. Returns
// "plaintext" when no rule matches. Keep this in sync with the frontend
// web/src/lib/fileLanguages.ts mapping.
func detectLanguage(path string) string {
	base := fileutil.BaseName(path)
	lower := strings.ToLower(base)

	// Special filenames first (they win over extension rules).
	switch lower {
	case "dockerfile", "makefile", "gnumakefile":
		return lower // "dockerfile" | "makefile" | "gnumakefile"
	case ".bashrc", ".bash_profile", ".bash_history", ".profile", ".zshrc":
		return "shell"
	case ".gitignore", ".gitattributes", ".dockerignore":
		return "plaintext"
	case ".editorconfig":
		return "ini"
	}

	// Dockerfile variants: Dockerfile.dev, Dockerfile.production, etc.
	if strings.HasPrefix(lower, "dockerfile.") {
		return "dockerfile"
	}

	// nginx.conf and *.conf → nginx (common case for SSHX target hosts)
	if base == "nginx.conf" || strings.HasSuffix(lower, ".conf") {
		return "nginx"
	}

	// Extension-based mapping.
	dot := strings.LastIndexByte(lower, '.')
	if dot < 0 || dot == len(lower)-1 {
		return "plaintext"
	}
	ext := lower[dot+1:]
	switch ext {
	case "sh", "bash", "zsh", "ksh":
		return "shell"
	case "yml", "yaml":
		return "yaml"
	case "json":
		return "json"
	case "toml":
		return "toml" // Monaco has no built-in toml; falls back gracefully
	case "xml", "svg":
		return "xml"
	case "py", "pyw":
		return "python"
	case "rb":
		return "ruby"
	case "go":
		return "go"
	case "rs":
		return "rust"
	case "js", "mjs", "cjs":
		return "javascript"
	case "ts":
		return "typescript"
	case "tsx":
		return "typescript"
	case "jsx":
		return "javascript"
	case "java":
		return "java"
	case "c", "h":
		return "c"
	case "cpp", "cc", "cxx", "hpp", "hxx":
		return "cpp"
	case "cs":
		return "csharp"
	case "php":
		return "php"
	case "sql":
		return "sql"
	case "md", "markdown":
		return "markdown"
	case "html", "htm":
		return "html"
	case "css":
		return "css"
	case "scss", "sass":
		return "scss"
	case "less":
		return "less"
	case "ini", "cfg", "conf", "properties", "props":
		return "ini"
	case "lua":
		return "lua"
	case "pl":
		return "perl"
	case "swift":
		return "swift"
	case "kt", "kts":
		return "kotlin"
	case "dart":
		return "dart"
	case "txt", "log":
		return "plaintext"
	default:
		return "plaintext"
	}
}
