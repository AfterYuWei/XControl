package handler

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

type ProfileHandler struct {
	profiles  store.ProfileStore
	vault     store.VaultStore
	encryptor *crypto.Encryptor
}

func NewProfileHandler(ps store.ProfileStore, vs store.VaultStore, enc *crypto.Encryptor) *ProfileHandler {
	return &ProfileHandler{profiles: ps, vault: vs, encryptor: enc}
}

func (h *ProfileHandler) List(w http.ResponseWriter, r *http.Request) {
	groupID := r.URL.Query().Get("group_id")
	search := r.URL.Query().Get("search")

	profiles, err := h.profiles.List(groupID, search)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

func (h *ProfileHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	profile, err := h.profiles.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func (h *ProfileHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req model.ProfileCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}

	if req.Name == "" || req.Host == "" || req.Username == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name, host, username are required")
		return
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.AuthType == "" {
		req.AuthType = "password"
	}
	if req.Icon == "" {
		req.Icon = "server"
	}

	// Store credential in vault: either reference an existing vault entry
	// (vault_id) or create a new one from inline password/private_key.
	var vaultID string
	if req.VaultID != "" {
		if _, err := h.vault.Get(req.VaultID); err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_VAULT", "vault entry not found")
			return
		}
		vaultID = req.VaultID
	} else if req.Password != "" || req.PrivKey != "" {
		cred := &model.Credential{
			Password:   req.Password,
			PrivKey:    req.PrivKey,
			Passphrase: req.Passphrase,
		}
		credType := "password"
		if req.PrivKey != "" {
			credType = "private_key"
		}
		var err error
		vaultID, err = h.vault.Store(cred, credType, "", "", "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "VAULT_ERROR", err.Error())
			return
		}
	}

	now := time.Now()
	profile := &model.Profile{
		ID:        uuid.New().String(),
		Name:      req.Name,
		Host:      req.Host,
		Port:      req.Port,
		Username:  req.Username,
		AuthType:  req.AuthType,
		Icon:      req.Icon,
		VaultID:   vaultID,
		GroupID:   req.GroupID,
		Tags:      req.Tags,
		Options:   req.Options,
		Note:      req.Note,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if profile.Tags == nil {
		profile.Tags = []string{}
	}
	if profile.Options == "" {
		profile.Options = "{}"
	}

	if err := h.profiles.Create(profile); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, profile)
}

func (h *ProfileHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.ProfileUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}

	// Handle credential update — empty string means "keep unchanged"
	hasNewPassword := req.Password != nil && *req.Password != ""
	hasNewKey := req.PrivKey != nil && *req.PrivKey != ""
	if hasNewPassword || hasNewKey {
		cred := &model.Credential{}
		credType := "password"
		if hasNewPassword {
			cred.Password = *req.Password
		}
		if hasNewKey {
			cred.PrivKey = *req.PrivKey
			credType = "private_key"
		}
		if req.Passphrase != nil {
			cred.Passphrase = *req.Passphrase
		}

		newVaultID, err := h.vault.Store(cred, credType, "", "", "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "VAULT_ERROR", err.Error())
			return
		}
		// Clean up old vault entry
		oldProfile, _ := h.profiles.Get(id)
		if oldProfile != nil && oldProfile.VaultID != "" {
			if refs, _ := h.vault.RefCount(oldProfile.VaultID); refs <= 1 {
				h.vault.Delete(oldProfile.VaultID)
			}
		}
		req.VaultID = &newVaultID
	}

	if err := h.profiles.Update(id, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}

	profile, err := h.profiles.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func (h *ProfileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	profile, _ := h.profiles.Get(id)
	if profile != nil && profile.VaultID != "" {
		if refs, _ := h.vault.RefCount(profile.VaultID); refs <= 1 {
			h.vault.Delete(profile.VaultID)
		}
	}

	if err := h.profiles.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
