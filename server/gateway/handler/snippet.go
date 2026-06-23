package handler

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/store"
)

type SnippetHandler struct {
	snippets store.SnippetStore
}

func NewSnippetHandler(ss store.SnippetStore) *SnippetHandler {
	return &SnippetHandler{snippets: ss}
}

func (h *SnippetHandler) List(w http.ResponseWriter, r *http.Request) {
	snippets, err := h.snippets.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snippets)
}

func (h *SnippetHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req model.SnippetCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Name == "" || req.Content == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name and content are required")
		return
	}

	isGlobal := true
	if req.IsGlobal != nil {
		isGlobal = *req.IsGlobal
	}
	tags := req.Tags
	if tags == nil {
		tags = []string{}
	}

	now := time.Now()
	snippet := &model.Snippet{
		ID:          uuid.New().String(),
		Name:        req.Name,
		Content:     req.Content,
		Description: req.Description,
		Tags:        tags,
		IsGlobal:    isGlobal,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := h.snippets.Create(snippet); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, snippet)
}

func (h *SnippetHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.SnippetUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if err := h.snippets.Update(id, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	snippet, err := h.snippets.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "snippet not found")
		return
	}
	writeJSON(w, http.StatusOK, snippet)
}

func (h *SnippetHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.snippets.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
