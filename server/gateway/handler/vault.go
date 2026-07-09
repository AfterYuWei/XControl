package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

// VaultHandler exposes CRUD + key generation for the key vault.
type VaultHandler struct {
	vault store.VaultStore
	audit store.AuditStore
}

func NewVaultHandler(vs store.VaultStore, as store.AuditStore) *VaultHandler {
	return &VaultHandler{vault: vs, audit: as}
}

// vaultCreateRequest is the payload for POST /api/vault.
type vaultCreateRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Username   string `json:"username"`
	Remark     string `json:"remark"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	PublicKey  string `json:"public_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

// vaultUpdateRequest is the payload for PUT /api/vault/{id}. All fields are
// applied as-is (no nil-means-keep semantics) to keep the credential atomically
// consistent.
type vaultUpdateRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Username   string `json:"username"`
	Remark     string `json:"remark"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	PublicKey  string `json:"public_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

// generateKeyRequest is the payload for POST /api/vault/generate.
type generateKeyRequest struct {
	Algo       string `json:"algo"`       // rsa | ed25519
	Bits       int    `json:"bits"`       // rsa only: 2048 | 4096
	Passphrase string `json:"passphrase"` // optional
}

// generateKeyResponse returns the generated keypair without persisting.
type generateKeyResponse struct {
	PublicKey   string `json:"public_key"`
	PrivateKey  string `json:"private_key"`
	Fingerprint string `json:"fingerprint"`
}

type vaultRevealResponse struct {
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	PublicKey  string `json:"public_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

func (h *VaultHandler) List(w http.ResponseWriter, r *http.Request) {
	filter := model.VaultListFilter{
		Type: r.URL.Query().Get("type"),
		Q:    r.URL.Query().Get("q"),
	}
	items, err := h.vault.List(filter)
	if err != nil {
		slog.Error("vault list error", "error", err, "filter", filter)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *VaultHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	item, err := h.vault.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "vault entry not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h *VaultHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req vaultCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name is required")
		return
	}
	if !isValidVaultType(req.Type) {
		writeError(w, http.StatusBadRequest, "VALIDATION", "invalid type")
		return
	}

	cred := &model.Credential{
		Password:   req.Password,
		PrivKey:    req.PrivateKey,
		PublicKey:  req.PublicKey,
		Passphrase: req.Passphrase,
	}
	ensurePublicKey(cred, req.Type)
	if err := validateCredential(cred, req.Type); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}

	id, err := h.vault.Store(cred, req.Type, req.Name, req.Username, req.Remark)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "VAULT_ERROR", err.Error())
		return
	}
	h.auditLog("vault_create", id, "name="+req.Name)

	item, err := h.vault.Get(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (h *VaultHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req vaultUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "name is required")
		return
	}
	if !isValidVaultType(req.Type) {
		writeError(w, http.StatusBadRequest, "VALIDATION", "invalid type")
		return
	}
	existing, err := h.vault.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "vault entry not found")
		return
	}
	if err := validateVaultTypeUpdate(existing.Type, req.Type); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}

	cred := &model.Credential{
		Password:   req.Password,
		PrivKey:    req.PrivateKey,
		PublicKey:  req.PublicKey,
		Passphrase: req.Passphrase,
	}
	ensurePublicKey(cred, req.Type)
	if err := validateCredential(cred, req.Type); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}

	if err := h.vault.Update(id, cred, req.Type, req.Name, req.Username, req.Remark); err != nil {
		writeError(w, http.StatusInternalServerError, "VAULT_ERROR", err.Error())
		return
	}
	h.auditLog("vault_update", id, "name="+req.Name)

	item, err := h.vault.Get(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h *VaultHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	// Block deletion when the credential is still referenced by profiles.
	refs, err := h.vault.References(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	if len(refs) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":      APIError{Code: "IN_USE", Message: "vault entry is referenced by profiles"},
			"references": refs,
		})
		return
	}

	if err := h.vault.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	h.auditLog("vault_delete", id, "")
	w.WriteHeader(http.StatusNoContent)
}

func (h *VaultHandler) References(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	refs, err := h.vault.References(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, refs)
}

// Reveal returns the decrypted credential payload for in-app display/copy.
// Used by the edit form (pre-fill) and copy-to-clipboard actions.
func (h *VaultHandler) Reveal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cred, err := h.vault.Retrieve(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "vault entry not found")
		return
	}
	publicKey := strings.TrimSpace(cred.PublicKey)
	if publicKey == "" {
		derivedPublicKey, derr := deriveAuthorizedPublicKey(cred)
		if derr != nil {
			slog.Warn("derive vault public key failed", "vault_id", id, "error", derr)
		} else {
			publicKey = derivedPublicKey
		}
	}
	h.auditLog("vault_reveal", id, "")
	writeJSON(w, http.StatusOK, vaultRevealResponse{
		Password:   cred.Password,
		PrivateKey: cred.PrivKey,
		PublicKey:  publicKey,
		Passphrase: cred.Passphrase,
	})
}

// GenerateKeyPair creates a new SSH keypair and returns it without persisting.
// The caller decides whether to save it via POST /api/vault.
func (h *VaultHandler) GenerateKeyPair(w http.ResponseWriter, r *http.Request) {
	var req generateKeyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}

	algo := strings.ToLower(req.Algo)
	if algo == "" {
		algo = "ed25519"
	}

	var pubKey gossh.PublicKey
	var privKey any
	var err error

	switch algo {
	case "rsa":
		bits := req.Bits
		if bits == 0 {
			bits = 4096
		}
		if bits != 2048 && bits != 4096 {
			writeError(w, http.StatusBadRequest, "VALIDATION", "rsa bits must be 2048 or 4096")
			return
		}
		key, gerr := rsa.GenerateKey(rand.Reader, bits)
		if gerr != nil {
			writeError(w, http.StatusInternalServerError, "KEYGEN_ERROR", gerr.Error())
			return
		}
		pubKey, err = gossh.NewPublicKey(&key.PublicKey)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "KEYGEN_ERROR", err.Error())
			return
		}
		privKey = key
	case "ed25519":
		pub, priv, gerr := ed25519.GenerateKey(rand.Reader)
		if gerr != nil {
			writeError(w, http.StatusInternalServerError, "KEYGEN_ERROR", gerr.Error())
			return
		}
		pubKey, err = gossh.NewPublicKey(pub)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "KEYGEN_ERROR", err.Error())
			return
		}
		privKey = priv
	default:
		writeError(w, http.StatusBadRequest, "VALIDATION", "algo must be rsa or ed25519")
		return
	}

	// Marshal to OpenSSH PEM format, optionally encrypted with a passphrase.
	var block *pem.Block
	if req.Passphrase != "" {
		block, err = gossh.MarshalPrivateKeyWithPassphrase(privKey, "", []byte(req.Passphrase))
	} else {
		block, err = gossh.MarshalPrivateKey(privKey, "")
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "KEYGEN_ERROR", err.Error())
		return
	}
	privPEM := string(pem.EncodeToMemory(block))

	pubLine := string(gossh.MarshalAuthorizedKey(pubKey))
	hash := sha256.New()
	hash.Write(pubKey.Marshal())
	fingerprint := hex.EncodeToString(hash.Sum(nil)[:8])

	writeJSON(w, http.StatusOK, generateKeyResponse{
		PublicKey:   strings.TrimSpace(pubLine),
		PrivateKey:  strings.TrimSpace(privPEM),
		Fingerprint: fingerprint,
	})
}

// validateCredential ensures the credential payload has the required fields
// for the given type.
func validateCredential(cred *model.Credential, credType string) error {
	switch credType {
	case model.VaultTypePassword:
		if cred.Password == "" {
			return fmt.Errorf("password is required for password type")
		}
	case model.VaultTypePrivateKey:
		if cred.PrivKey == "" {
			return fmt.Errorf("private_key is required for private_key type")
		}
	default:
		return fmt.Errorf("unsupported type: %s", credType)
	}
	return nil
}

func isValidVaultType(t string) bool {
	return t == model.VaultTypePassword || t == model.VaultTypePrivateKey
}

func validateVaultTypeUpdate(existingType, requestedType string) error {
	if existingType == "" || requestedType == "" || existingType == requestedType {
		return nil
	}
	return fmt.Errorf("credential type cannot be changed")
}

func deriveAuthorizedPublicKey(cred *model.Credential) (string, error) {
	if cred == nil || strings.TrimSpace(cred.PrivKey) == "" {
		return "", nil
	}

	var (
		raw any
		err error
	)
	if cred.Passphrase != "" {
		raw, err = gossh.ParseRawPrivateKeyWithPassphrase([]byte(cred.PrivKey), []byte(cred.Passphrase))
	} else {
		raw, err = gossh.ParseRawPrivateKey([]byte(cred.PrivKey))
	}
	if err != nil {
		return "", fmt.Errorf("parse private key: %w", err)
	}

	signer, err := gossh.NewSignerFromKey(raw)
	if err != nil {
		return "", fmt.Errorf("create signer: %w", err)
	}

	return strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey()))), nil
}

func ensurePublicKey(cred *model.Credential, credType string) {
	if cred == nil {
		return
	}

	cred.PublicKey = strings.TrimSpace(cred.PublicKey)
	if cred.PublicKey != "" {
		return
	}

	if credType != model.VaultTypePrivateKey {
		return
	}

	publicKey, err := deriveAuthorizedPublicKey(cred)
	if err != nil {
		slog.Warn("derive vault public key for storage failed", "type", credType, "error", err)
		return
	}

	cred.PublicKey = publicKey
}

func (h *VaultHandler) auditLog(action, profileID, detail string) {
	_ = h.audit.Log(&model.AuditLog{
		ID:        uuid.New().String(),
		ProfileID: profileID,
		Action:    action,
		Detail:    detail,
		Timestamp: time.Now(),
	})
}
