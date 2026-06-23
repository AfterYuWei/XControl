package handler

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/store"
)

type GroupHandler struct {
	groups store.GroupStore
}

func NewGroupHandler(gs store.GroupStore) *GroupHandler {
	return &GroupHandler{groups: gs}
}

func (h *GroupHandler) List(w http.ResponseWriter, r *http.Request) {
	groups, err := h.groups.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (h *GroupHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req model.GroupCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name is required")
		return
	}
	if req.Icon == "" {
		req.Icon = "📁"
	}

	group := &model.Group{
		ID:        uuid.New().String(),
		Name:      req.Name,
		ParentID:  req.ParentID,
		Icon:      req.Icon,
		CreatedAt: time.Now(),
	}

	if err := h.groups.Create(group); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, group)
}

func (h *GroupHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.GroupUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if err := h.groups.Update(id, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	group, err := h.groups.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "group not found")
		return
	}
	writeJSON(w, http.StatusOK, group)
}

func (h *GroupHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.groups.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
