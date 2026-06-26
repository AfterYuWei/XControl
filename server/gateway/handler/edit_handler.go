package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/yuweinfo/sshx/fileutil"
	"github.com/yuweinfo/sshx/model"
)

// EditHandler provides a unified API for file editing across different
// session types (SFTP and ServerDetail). It routes requests to the
// appropriate backend based on the session ID.
//
// Routes:
//
//	GET  /api/edit/sessions/{id}/file?path=...  → read file as text
//	PUT  /api/edit/sessions/{id}/file?path=...  → write file
type EditHandler struct {
	sftpH   *SftpHandler
	serverH *ServerDetailHandler
}

func NewEditHandler(sftpH *SftpHandler, serverH *ServerDetailHandler) *EditHandler {
	return &EditHandler{
		sftpH:   sftpH,
		serverH: serverH,
	}
}

// ReadFile handles GET /api/edit/sessions/{id}/file?path=...
func (h *EditHandler) ReadFile(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.resolveBackend(w, r)
	if !ok {
		return
	}

	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	resp, err := ReadFileContent(r.Context(), backend, p)
	if err != nil {
		h.handleEditError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// WriteFile handles PUT /api/edit/sessions/{id}/file?path=...
func (h *EditHandler) WriteFile(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.resolveBackend(w, r)
	if !ok {
		return
	}

	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	var req model.SftpFileWriteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}

	resp, err := WriteFileContent(r.Context(), backend, p, req)
	if err != nil {
		h.handleEditError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// resolveBackend looks up the session ID in both SFTP and ServerDetail
// handlers and returns the appropriate FileBackend.
func (h *EditHandler) resolveBackend(w http.ResponseWriter, r *http.Request) (fileutil.FileBackend, bool) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "session id is required")
		return nil, false
	}

	// Try SFTP session first
	if backend, ok := h.sftpH.GetSessionBackend(id); ok {
		return backend, true
	}

	// Try ServerDetail session
	if backend, ok := h.serverH.GetSessionBackend(id); ok {
		return backend, true
	}

	writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
	return nil, false
}

// handleEditError converts FileEditError to appropriate HTTP responses.
func (h *EditHandler) handleEditError(w http.ResponseWriter, err error) {
	var editErr *FileEditError
	if errors.As(err, &editErr) {
		switch editErr.Code {
		case "FILE_TOO_LARGE":
			writeError(w, http.StatusRequestEntityTooLarge, editErr.Code, editErr.Message)
		case "BINARY_FILE", "UNSUPPORTED_ENCODING":
			writeError(w, http.StatusUnsupportedMediaType, editErr.Code, editErr.Message)
		case "IS_DIRECTORY":
			writeError(w, http.StatusBadRequest, editErr.Code, editErr.Message)
		case "FILE_MODIFIED":
			writeError(w, http.StatusConflict, editErr.Code, editErr.Message)
		case "INVALID_MOD_TIME":
			writeError(w, http.StatusBadRequest, editErr.Code, editErr.Message)
		default:
			writeError(w, http.StatusInternalServerError, editErr.Code, editErr.Message)
		}
		return
	}

	// Generic error
	slog.Error("edit handler error", "error", err)
	writeError(w, http.StatusInternalServerError, "EDIT_FAILED", err.Error())
}
