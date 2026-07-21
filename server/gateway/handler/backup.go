package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

const maxBackupSize = 50 << 20 // 50 MB

// backupAAD binds the encrypted payload to the backup format+version, so a
// ciphertext cannot be replayed in a different context.
var backupAAD = []byte(fmt.Sprintf("%s:%d", model.BackupFormat, model.BackupVersion))

type BackupHandler struct {
	backups *store.BackupStore
	audit   store.AuditStore
}

func NewBackupHandler(backups *store.BackupStore, audit store.AuditStore) *BackupHandler {
	return &BackupHandler{backups: backups, audit: audit}
}

// Export handles GET /api/backup/export?credentials=none|encrypted|plain&password=***
func (h *BackupHandler) Export(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("credentials")
	if mode == "" {
		mode = model.BackupCredEncrypted
	}
	switch mode {
	case model.BackupCredNone, model.BackupCredEncrypted, model.BackupCredPlain:
	default:
		writeError(w, http.StatusBadRequest, "INVALID_MODE", "credentials 参数须为 none | encrypted | plain")
		return
	}

	password := r.URL.Query().Get("password")
	if mode == model.BackupCredEncrypted && password == "" {
		writeError(w, http.StatusBadRequest, "PASSWORD_REQUIRED", "加密导出必须提供密码")
		return
	}

	payload, err := h.backups.Export()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EXPORT_FAILED", err.Error())
		return
	}

	file := &model.BackupFile{
		Format:         model.BackupFormat,
		Version:        model.BackupVersion,
		ExportedAt:     time.Now().UTC(),
		CredentialMode: mode,
	}

	switch mode {
	case model.BackupCredEncrypted:
		kdf, err := crypto.NewKDFParams()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "KDF_FAILED", err.Error())
			return
		}
		key, err := crypto.DeriveKeyArgon2id(password, kdf)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "KDF_FAILED", err.Error())
			return
		}
		plaintext, err := json.Marshal(payload)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EXPORT_FAILED", err.Error())
			return
		}
		file.Payload, err = crypto.EncryptWithKey(key, plaintext, backupAAD)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "ENCRYPT_FAILED", err.Error())
			return
		}
		file.KDF = kdf
	default: // none | plain
		if mode == model.BackupCredNone {
			stripCredentials(payload)
		}
		file.Groups = payload.Groups
		file.Vault = payload.Vault
		file.Profiles = payload.Profiles
		file.Snippets = payload.Snippets
	}

	body, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EXPORT_FAILED", err.Error())
		return
	}

	filename := fmt.Sprintf("xcontrol-backup-%s.xcbackup", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Write(body)
}

// stripCredentials removes all credential material for "none" mode. Vault
// references are cleared as well so imports never dangle.
func stripCredentials(p *model.BackupPayload) {
	p.Vault = []*model.BackupVaultItem{}
	for _, pr := range p.Profiles {
		pr.InlineCredential = nil
		pr.VaultID = ""
		if pr.AuthType == "vault" {
			pr.AuthType = "none"
		}
	}
}

// Preview handles POST /api/backup/preview (multipart: file, password).
// It parses and validates the backup without touching the DB, returning
// content stats and per-resource conflict counts.
func (h *BackupHandler) Preview(w http.ResponseWriter, r *http.Request) {
	parsed, err := h.parseUploadedBackup(r)
	if err != nil {
		writeBackupParseError(w, err)
		return
	}

	conflicts, err := h.backups.Conflicts(parsed.payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PREVIEW_FAILED", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, model.BackupPreviewResponse{
		CredentialMode: parsed.mode,
		ExportedAt:     parsed.exportedAt,
		Stats: model.BackupStats{
			Groups:   len(parsed.payload.Groups),
			Vault:    len(parsed.payload.Vault),
			Profiles: len(parsed.payload.Profiles),
			Snippets: len(parsed.payload.Snippets),
		},
		Conflicts: *conflicts,
	})
}

// Import handles POST /api/backup/import (multipart: file, password, strategy).
func (h *BackupHandler) Import(w http.ResponseWriter, r *http.Request) {
	parsed, err := h.parseUploadedBackup(r)
	if err != nil {
		writeBackupParseError(w, err)
		return
	}

	strategy := r.FormValue("strategy")
	if strategy == "" {
		strategy = model.BackupStrategySkip
	}

	result, err := h.backups.Import(parsed.payload, strategy)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "IMPORT_FAILED", err.Error())
		return
	}

	_ = h.audit.Log(&model.AuditLog{
		ID:     uuid.NewString(),
		Action: "import",
		Detail: fmt.Sprintf("mode=%s strategy=%s groups=%d vault=%d profiles=%d snippets=%d",
			parsed.mode, strategy,
			result.Imported.Groups, result.Imported.Vault, result.Imported.Profiles, result.Imported.Snippets),
		Timestamp: time.Now(),
	})

	writeJSON(w, http.StatusOK, result)
}

// parsedBackup carries the decoded payload plus file-level metadata.
type parsedBackup struct {
	payload    *model.BackupPayload
	mode       string
	exportedAt time.Time
}

// parseUploadedBackup reads the multipart upload and returns the decoded
// business payload. It never writes to the DB.
func (h *BackupHandler) parseUploadedBackup(r *http.Request) (*parsedBackup, error) {
	if err := r.ParseMultipartForm(maxBackupSize); err != nil {
		return nil, fmt.Errorf("parse form: %w", err)
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		return nil, fmt.Errorf("缺少上传文件: %w", err)
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, maxBackupSize+1))
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	if len(raw) > maxBackupSize {
		return nil, fmt.Errorf("备份文件超过 50MB 限制")
	}

	return decodeBackupFile(raw, r.FormValue("password"))
}

// decodeBackupFile validates and decodes a raw .xcbackup document into the
// business payload, decrypting when necessary.
func decodeBackupFile(raw []byte, password string) (*parsedBackup, error) {
	var file model.BackupFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("备份文件格式无效: %w", err)
	}
	if file.Format != model.BackupFormat {
		return nil, fmt.Errorf("不是有效的 XControl 备份文件")
	}
	if file.Version > model.BackupVersion {
		return nil, fmt.Errorf("备份版本 %d 过新，当前仅支持 ≤ %d", file.Version, model.BackupVersion)
	}

	switch file.CredentialMode {
	case model.BackupCredEncrypted:
		if password == "" {
			return nil, errPasswordRequired
		}
		if file.KDF == nil {
			return nil, fmt.Errorf("加密备份缺少 kdf 参数")
		}
		key, err := crypto.DeriveKeyArgon2id(password, file.KDF)
		if err != nil {
			return nil, fmt.Errorf("kdf 参数无效: %w", err)
		}
		plaintext, err := crypto.DecryptWithKey(key, backupAAD, file.Payload)
		if err != nil {
			return nil, errInvalidPassword
		}
		var payload model.BackupPayload
		if err := json.Unmarshal(plaintext, &payload); err != nil {
			return nil, fmt.Errorf("备份内容损坏: %w", err)
		}
		normalizePayload(&payload)
		return &parsedBackup{payload: &payload, mode: file.CredentialMode, exportedAt: file.ExportedAt}, nil

	case model.BackupCredNone, model.BackupCredPlain:
		payload := model.BackupPayload{
			Groups:   file.Groups,
			Vault:    file.Vault,
			Profiles: file.Profiles,
			Snippets: file.Snippets,
		}
		normalizePayload(&payload)
		if file.CredentialMode == model.BackupCredNone {
			stripCredentials(&payload)
		}
		return &parsedBackup{payload: &payload, mode: file.CredentialMode, exportedAt: file.ExportedAt}, nil

	default:
		return nil, fmt.Errorf("未知的 credential_mode: %q", file.CredentialMode)
	}
}

func normalizePayload(p *model.BackupPayload) {
	if p.Groups == nil {
		p.Groups = []*model.Group{}
	}
	if p.Vault == nil {
		p.Vault = []*model.BackupVaultItem{}
	}
	if p.Profiles == nil {
		p.Profiles = []*model.BackupProfile{}
	}
	if p.Snippets == nil {
		p.Snippets = []*model.Snippet{}
	}
	for _, pr := range p.Profiles {
		if pr.Tags == nil {
			pr.Tags = []string{}
		}
	}
	for _, sn := range p.Snippets {
		if sn.Tags == nil {
			sn.Tags = []string{}
		}
	}
}

// Sentinel errors mapped to specific HTTP error codes.
var (
	errPasswordRequired = fmt.Errorf("该备份已加密，请输入导出密码")
	errInvalidPassword  = fmt.Errorf("密码错误或备份文件已损坏")
)

func writeBackupParseError(w http.ResponseWriter, err error) {
	switch err {
	case errPasswordRequired:
		writeError(w, http.StatusBadRequest, "PASSWORD_REQUIRED", err.Error())
	case errInvalidPassword:
		writeError(w, http.StatusBadRequest, "INVALID_PASSWORD", err.Error())
	default:
		writeError(w, http.StatusBadRequest, "INVALID_BACKUP_FORMAT", err.Error())
	}
}
