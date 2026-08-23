package handler

import (
	"fmt"
	"net/http"
	"strings"
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

	req.Name = strings.TrimSpace(req.Name)
	req.Host = strings.TrimSpace(req.Host)
	req.Username = strings.TrimSpace(req.Username)
	if req.Name == "" || req.Host == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name and host are required")
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

	vaultID, inlineCredential, err := h.prepareCredentialOnCreate(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}
	if req.Username == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "username is required")
		return
	}

	now := time.Now()
	profile := &model.Profile{
		ID:               uuid.New().String(),
		Name:             req.Name,
		Host:             req.Host,
		Port:             req.Port,
		Username:         req.Username,
		AuthType:         req.AuthType,
		Icon:             req.Icon,
		VaultID:          vaultID,
		InlineCredential: inlineCredential,
		GroupID:          req.GroupID,
		Tags:             req.Tags,
		Options:          req.Options,
		Note:             req.Note,
		CreatedAt:        now,
		UpdatedAt:        now,
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

	current, err := h.profiles.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}

	if err := h.prepareCredentialOnUpdate(current, &req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
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

	if err := h.profiles.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ProfileHandler) prepareCredentialOnCreate(req *model.ProfileCreateRequest) (vaultID string, inlineCredential string, err error) {
	switch req.AuthType {
	case "vault":
		if req.VaultID == "" {
			return "", "", fmt.Errorf("vault_id is required for vault auth")
		}
		item, err := h.vault.Get(req.VaultID)
		if err != nil {
			return "", "", fmt.Errorf("vault entry not found")
		}
		if err := applyVaultUsername(item, req.Username, func(username string) {
			req.Username = username
		}); err != nil {
			return "", "", err
		}
		return req.VaultID, "", nil
	case "password":
		if req.Username == "" {
			return "", "", fmt.Errorf("username is required")
		}
		if req.Password == "" {
			return "", "", fmt.Errorf("password is required for password auth")
		}
		inlineCredential, err = store.EncodeInlineCredential(h.encryptor, &model.Credential{
			Password: req.Password,
		})
		return "", inlineCredential, err
	case "key":
		if req.Username == "" {
			return "", "", fmt.Errorf("username is required")
		}
		if req.PrivKey == "" {
			return "", "", fmt.Errorf("private_key is required for key auth")
		}
		inlineCredential, err = store.EncodeInlineCredential(h.encryptor, &model.Credential{
			PrivKey:    req.PrivKey,
			Passphrase: req.Passphrase,
		})
		return "", inlineCredential, err
	case "agent":
		if req.Username == "" {
			return "", "", fmt.Errorf("username is required")
		}
		return "", "", nil
	default:
		return "", "", fmt.Errorf("unsupported auth_type: %s", req.AuthType)
	}
}

func (h *ProfileHandler) prepareCredentialOnUpdate(current *model.Profile, req *model.ProfileUpdateRequest) error {
	nextAuthType := current.AuthType
	if req.AuthType != nil && *req.AuthType != "" {
		nextAuthType = *req.AuthType
	}
	nextUsername := strings.TrimSpace(current.Username)
	requestedUsername := ""
	if req.Username != nil {
		trimmed := strings.TrimSpace(*req.Username)
		req.Username = &trimmed
		nextUsername = trimmed
		requestedUsername = trimmed
	}

	switch nextAuthType {
	case "vault":
		vaultID := current.VaultID
		if req.VaultID != nil {
			if *req.VaultID == "" {
				return fmt.Errorf("vault_id is required for vault auth")
			}
			vaultID = *req.VaultID
		} else if current.VaultID == "" {
			return fmt.Errorf("vault_id is required for vault auth")
		}
		item, err := h.vault.Get(vaultID)
		if err != nil {
			return fmt.Errorf("vault entry not found")
		}
		vaultUsername := requestedUsername
		if item.Type != model.VaultTypePassword {
			vaultUsername = nextUsername
		}
		if err := applyVaultUsername(item, vaultUsername, func(username string) {
			req.Username = &username
		}); err != nil {
			return err
		}
		empty := ""
		req.InlineCredential = &empty
		return nil

	case "password", "key", "agent":
		if nextUsername == "" {
			return fmt.Errorf("username is required")
		}
		cred, err := resolveProfileCredential(current, h.vault, h.encryptor)
		if err != nil {
			return err
		}
		if cred == nil {
			cred = &model.Credential{}
		}

		switch nextAuthType {
		case "password":
			if req.Password != nil && *req.Password != "" {
				cred.Password = *req.Password
			}
			if cred.Password == "" {
				return fmt.Errorf("password is required for password auth")
			}
			cred.PrivKey = ""
			cred.Passphrase = ""
		case "key":
			if req.PrivKey != nil && *req.PrivKey != "" {
				cred.PrivKey = *req.PrivKey
			}
			if req.Passphrase != nil {
				cred.Passphrase = *req.Passphrase
			}
			if cred.PrivKey == "" {
				return fmt.Errorf("private_key is required for key auth")
			}
			cred.Password = ""
		case "agent":
			cred = &model.Credential{}
		}

		inlineCredential, err := store.EncodeInlineCredential(h.encryptor, cred)
		if err != nil {
			return err
		}
		req.InlineCredential = &inlineCredential
		empty := ""
		req.VaultID = &empty
		return nil

	default:
		return fmt.Errorf("unsupported auth_type: %s", nextAuthType)
	}
}

func applyVaultUsername(item *model.VaultItem, requestedUsername string, setUsername func(string)) error {
	if item == nil {
		return fmt.Errorf("vault entry not found")
	}
	requestedUsername = strings.TrimSpace(requestedUsername)
	if item.Type != model.VaultTypePassword {
		if requestedUsername == "" {
			return fmt.Errorf("username is required")
		}
		setUsername(requestedUsername)
		return nil
	}

	vaultUsername := strings.TrimSpace(item.Username)
	if vaultUsername == "" {
		return fmt.Errorf("password vault username is missing; update the vault entry before using it")
	}
	if requestedUsername != "" && requestedUsername != vaultUsername {
		return fmt.Errorf("username must match the password vault username")
	}
	setUsername(vaultUsername)
	return nil
}
