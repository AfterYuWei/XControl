package handler

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yuweinfo/xcontrol/fileutil"
	"github.com/yuweinfo/xcontrol/model"
)

// --- Unified file editor core logic ---
//
// This file contains the shared read/write logic used by both SFTP and
// ServerDetail edit handlers. The functions are backend-agnostic — they
// operate on the fileutil.FileBackend interface.

// ReadFileContent reads a remote file as text with size, binary, and encoding
// guards. Returns a response ready for the frontend editor.
func ReadFileContent(ctx context.Context, backend fileutil.FileBackend, path string) (*model.SftpFileReadResponse, error) {
	cleanPath := fileutil.CleanPath(path)

	info, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir {
		return nil, &FileEditError{Code: "IS_DIRECTORY", Message: "cannot edit a directory"}
	}

	// Guard 1: size
	if info.Size > model.MaxEditableFileSize {
		return nil, &FileEditError{Code: "FILE_TOO_LARGE", Message: "文件过大，无法在编辑器中打开（上限 10MB），请下载后本地编辑"}
	}

	rc, err := backend.OpenRead(ctx, cleanPath)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	// Read up to MaxEditableFileSize
	buf := make([]byte, 0, info.Size+1)
	tmp := make([]byte, 64*1024)
	for {
		n, rerr := rc.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if int64(len(buf)) > model.MaxEditableFileSize {
				return nil, &FileEditError{Code: "FILE_TOO_LARGE", Message: "文件在读取过程中变大超过 10MB 上限"}
			}
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				break
			}
			return nil, rerr
		}
	}

	// Guard 2: binary sniff (NUL byte in first 8KB)
	sniffLen := len(buf)
	if sniffLen > model.BinarySniffSize {
		sniffLen = model.BinarySniffSize
	}
	if bytes.IndexByte(buf[:sniffLen], 0) >= 0 {
		return nil, &FileEditError{Code: "BINARY_FILE", Message: "该文件为二进制文件，无法在文本编辑器中打开"}
	}

	// Guard 3: UTF-8 validity
	if !utf8.Valid(buf) {
		return nil, &FileEditError{Code: "UNSUPPORTED_ENCODING", Message: "文件不是有效的 UTF-8 编码（当前仅支持 UTF-8）"}
	}

	content := string(buf)
	lineEnding := detectLineEnding(buf)
	// Normalize CRLF → LF for the editor
	if lineEnding == model.LineEndingCRLF {
		content = strings.ReplaceAll(content, "\r\n", "\n")
	}

	readOnly := !isWritable(info.Mode)

	return &model.SftpFileReadResponse{
		Path:       cleanPath,
		Content:    content,
		Size:       info.Size,
		ModTime:    info.ModTime.Format(time.RFC3339Nano),
		Language:   detectLanguage(cleanPath),
		LineEnding: lineEnding,
		ReadOnly:   readOnly,
	}, nil
}

// WriteFileContent writes content to a remote file with optimistic locking.
// Returns the new mod_time for the next save.
// If the file does not exist, it will be created (new file support).
func WriteFileContent(ctx context.Context, backend fileutil.FileBackend, path string, req model.SftpFileWriteRequest) (*model.SftpFileWriteResponse, error) {
	cleanPath := fileutil.CleanPath(path)

	// Optimistic lock: verify the file hasn't changed since the client read it.
	// If the file does not exist, treat this as a create operation.
	current, err := backend.Stat(ctx, cleanPath)
	isNewFile := errors.Is(err, fileutil.ErrNotFound)
	if err != nil && !isNewFile {
		return nil, err
	}
	if !isNewFile {
		if current.IsDir {
			return nil, &FileEditError{Code: "IS_DIRECTORY", Message: "cannot write a directory"}
		}
		if req.ExpectedModTime != "" {
			expected, perr := time.Parse(time.RFC3339Nano, req.ExpectedModTime)
			if perr != nil {
				return nil, &FileEditError{Code: "INVALID_MOD_TIME", Message: "expected_mod_time is not a valid RFC 3339 timestamp"}
			}
			if !current.ModTime.Equal(expected) {
				return nil, &FileEditError{Code: "FILE_MODIFIED", Message: "文件在编辑期间已被其他进程修改，请重新加载以避免覆盖"}
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
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}

	data := []byte(content)

	// Enforce the size limit on write too
	if int64(len(data)) > model.MaxEditableFileSize {
		return nil, &FileEditError{Code: "FILE_TOO_LARGE", Message: "保存后文件大小超过 10MB 上限"}
	}

	wc, err := backend.OpenWrite(ctx, cleanPath)
	if err != nil {
		return nil, err
	}
	if _, err := wc.Write(data); err != nil {
		wc.Close()
		return nil, err
	}
	if err := wc.Close(); err != nil {
		return nil, err
	}

	// Re-stat to obtain the new ModTime
	updated, err := backend.Stat(ctx, cleanPath)
	if err != nil {
		// Write succeeded but re-stat failed.
		if isNewFile {
			// For new files, use current time as fallback.
			return &model.SftpFileWriteResponse{
				Path:    cleanPath,
				Size:    int64(len(data)),
				ModTime: time.Now().Format(time.RFC3339Nano),
			}, nil
		}
		// For existing files, fall back to current's mtime.
		return &model.SftpFileWriteResponse{
			Path:    cleanPath,
			Size:    int64(len(data)),
			ModTime: current.ModTime.Format(time.RFC3339Nano),
		}, nil
	}

	return &model.SftpFileWriteResponse{
		Path:    cleanPath,
		Size:    updated.Size,
		ModTime: updated.ModTime.Format(time.RFC3339Nano),
	}, nil
}

// FileEditError represents a guarded error from the file editor.
type FileEditError struct {
	Code    string
	Message string
}

func (e *FileEditError) Error() string {
	return e.Message
}

// --- Helper functions (shared with sftp_editor.go) ---

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

// isWritable reports whether a permission-string grants the owner write bit.
func isWritable(modeStr string) bool {
	s := strings.TrimSpace(modeStr)
	if len(s) == 10 {
		s = s[1:]
	}
	if len(s) < 9 {
		return true
	}
	return s[1] == 'w'
}

// detectLanguage maps a POSIX file path to a Monaco language id.
func detectLanguage(path string) string {
	base := fileutil.BaseName(path)
	lower := strings.ToLower(base)

	switch lower {
	case "dockerfile", "makefile", "gnumakefile":
		return lower
	case ".bashrc", ".bash_profile", ".bash_history", ".profile", ".zshrc":
		return "shell"
	case ".gitignore", ".gitattributes", ".dockerignore":
		return "plaintext"
	case ".editorconfig":
		return "ini"
	}

	if strings.HasPrefix(lower, "dockerfile.") {
		return "dockerfile"
	}

	if base == "nginx.conf" || strings.HasSuffix(lower, ".conf") {
		return "nginx"
	}

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
		return "toml"
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
	case "ts", "tsx":
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
