package handler

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/store"
)

type GroupHandler struct {
	groups   store.GroupStore
	profiles store.ProfileStore
}

func NewGroupHandler(gs store.GroupStore, ps store.ProfileStore) *GroupHandler {
	return &GroupHandler{groups: gs, profiles: ps}
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
		req.Icon = "folder"
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

	// Block deletion when the group still contains servers — the user must
	// move or delete them first so no connection is orphaned silently.
	count, err := h.profiles.CountByGroup(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	if count > 0 {
		writeError(w, http.StatusConflict, "GROUP_NOT_EMPTY",
			"该分组下仍有 "+itoa(count)+" 台服务器，请先移动或删除后再删除分组")
		return
	}

	if err := h.groups.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// itoa is a small helper to avoid pulling strconv into every handler build.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
