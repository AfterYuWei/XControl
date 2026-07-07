package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

type sqliteVaultStore struct {
	db        *sql.DB
	encryptor *crypto.Encryptor
}

func NewVaultStore(db *sql.DB, encryptor *crypto.Encryptor) VaultStore {
	return &sqliteVaultStore{db: db, encryptor: encryptor}
}

// encodePlaintext builds the plaintext to encrypt and the fingerprint for a
// given credential type.
func encodePlaintext(cred *model.Credential, credType string) (plaintext, fingerprint string, err error) {
	switch credType {
	case model.VaultTypePassword:
		plaintext = cred.Password
		// Password fingerprint is intentionally empty — listing shows "-".
		return plaintext, "", nil
	case model.VaultTypePrivateKey:
		plaintext = cred.PrivKey
		if cred.Passphrase != "" {
			plaintext += "\x00" + cred.Passphrase
		}
		h := sha256.Sum256([]byte(cred.PrivKey))
		return plaintext, hex.EncodeToString(h[:8]), nil
	case model.VaultTypeSSHCertificate:
		plaintext = cred.Cert + "\x00" + cred.PrivKey
		if cred.Passphrase != "" {
			plaintext += "\x00" + cred.Passphrase
		}
		fp, fpErr := certFingerprint(cred.Cert)
		if fpErr != nil {
			return "", "", fmt.Errorf("compute cert fingerprint: %w", fpErr)
		}
		return plaintext, fp, nil
	default:
		return "", "", fmt.Errorf("unsupported vault type: %s", credType)
	}
}

// certFingerprint parses an OpenSSH certificate and returns a stable
// fingerprint derived from the certificate serial + CA signature key.
func certFingerprint(certPEM string) (string, error) {
	pubKey, _, _, _, err := gossh.ParseAuthorizedKey([]byte(certPEM))
	if err != nil {
		return "", fmt.Errorf("parse certificate: %w", err)
	}
	cert, ok := pubKey.(*gossh.Certificate)
	if !ok {
		// Not a certificate — fall back to the public key marshal sha256.
		h := sha256.Sum256(pubKey.Marshal())
		return hex.EncodeToString(h[:8]), nil
	}
	ca := sha256.Sum256(cert.SignatureKey.Marshal())
	serial := fmt.Sprintf("%d", cert.Serial)
	combined := append([]byte(serial), ca[:]...)
	h := sha256.Sum256(combined)
	return hex.EncodeToString(h[:8]), nil
}

// decodePlaintext reverses encodePlaintext into a Credential.
func decodePlaintext(decrypted, credType string) *model.Credential {
	cred := &model.Credential{}
	switch credType {
	case model.VaultTypePassword:
		cred.Password = decrypted
	case model.VaultTypePrivateKey:
		parts := strings.SplitN(decrypted, "\x00", 2)
		cred.PrivKey = parts[0]
		if len(parts) == 2 {
			cred.Passphrase = parts[1]
		}
	case model.VaultTypeSSHCertificate:
		parts := strings.SplitN(decrypted, "\x00", 3)
		if len(parts) >= 1 {
			cred.Cert = parts[0]
		}
		if len(parts) >= 2 {
			cred.PrivKey = parts[1]
		}
		if len(parts) >= 3 {
			cred.Passphrase = parts[2]
		}
	}
	return cred
}

func (s *sqliteVaultStore) Store(cred *model.Credential, credType, name, username, remark string) (string, error) {
	plaintext, fingerprint, err := encodePlaintext(cred, credType)
	if err != nil {
		return "", err
	}

	encrypted, err := s.encryptor.Encrypt(plaintext)
	if err != nil {
		return "", err
	}

	id := uuid.New().String()
	now := time.Now()
	_, err = s.db.Exec(
		`INSERT INTO vault (id, type, data, fingerprint, name, username, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, credType, encrypted, fingerprint, name, username, remark, now, now,
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *sqliteVaultStore) Retrieve(id string) (*model.Credential, error) {
	var data, credType string
	err := s.db.QueryRow(`SELECT type, data FROM vault WHERE id = ?`, id).Scan(&credType, &data)
	if err != nil {
		return nil, err
	}

	decrypted, err := s.encryptor.Decrypt(data)
	if err != nil {
		return nil, err
	}
	return decodePlaintext(decrypted, credType), nil
}

func (s *sqliteVaultStore) Update(id string, cred *model.Credential, credType, name, username, remark string) error {
	plaintext, fingerprint, err := encodePlaintext(cred, credType)
	if err != nil {
		return err
	}
	encrypted, err := s.encryptor.Encrypt(plaintext)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`UPDATE vault SET type = ?, data = ?, fingerprint = ?, name = ?, username = ?, remark = ?, updated_at = ? WHERE id = ?`,
		credType, encrypted, fingerprint, name, username, remark, time.Now(), id,
	)
	return err
}

func (s *sqliteVaultStore) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM vault WHERE id = ?`, id)
	return err
}

func (s *sqliteVaultStore) RefCount(id string) (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM profiles WHERE vault_id = ?`, id).Scan(&count)
	return count, err
}

func (s *sqliteVaultStore) References(id string) ([]model.ProfileRef, error) {
	rows, err := s.db.Query(`SELECT id, name FROM profiles WHERE vault_id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	refs := make([]model.ProfileRef, 0)
	for rows.Next() {
		var r model.ProfileRef
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			return nil, err
		}
		refs = append(refs, r)
	}
	return refs, rows.Err()
}

func (s *sqliteVaultStore) Get(id string) (*model.VaultItem, error) {
	var (
		vType, data, name, username, remark, fingerprint string
		createdAt, updatedAt                             time.Time
	)
	err := s.db.QueryRow(
		`SELECT type, data, name, username, remark, fingerprint, created_at, updated_at FROM vault WHERE id = ?`,
		id,
	).Scan(&vType, &data, &name, &username, &remark, &fingerprint, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}

	refCount, _ := s.RefCount(id)
	hasPassphrase := false
	if decrypted, derr := s.encryptor.Decrypt(data); derr == nil {
		hasPassphrase = s.detectPassphrase(decrypted, vType)
	}

	return &model.VaultItem{
		ID:            id,
		Name:          name,
		Type:          vType,
		Username:      username,
		Remark:        remark,
		Fingerprint:   fingerprint,
		RefCount:      refCount,
		HasPassphrase: hasPassphrase,
		CreatedAt:     createdAt,
		UpdatedAt:     updatedAt,
	}, nil
}

func (s *sqliteVaultStore) List(filter model.VaultListFilter) ([]*model.VaultItem, error) {
	query := `SELECT id, type, data, name, username, remark, fingerprint, created_at, updated_at FROM vault`
	args := []any{}
	where := []string{}
	if filter.Type != "" {
		where = append(where, "type = ?")
		args = append(args, filter.Type)
	}
	if filter.Q != "" {
		where = append(where, "(name LIKE ? OR remark LIKE ? OR username LIKE ?)")
		pattern := "%" + filter.Q + "%"
		args = append(args, pattern, pattern, pattern)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY updated_at DESC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]*model.VaultItem, 0)
	for rows.Next() {
		var (
			vID, vType, data, name, username, remark, fingerprint string
			createdAt, updatedAt                                  time.Time
		)
		if err := rows.Scan(&vID, &vType, &data, &name, &username, &remark, &fingerprint, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		refCount, _ := s.RefCount(vID)
		hasPassphrase := false
		if decrypted, derr := s.encryptor.Decrypt(data); derr == nil {
			hasPassphrase = s.detectPassphrase(decrypted, vType)
		}
		items = append(items, &model.VaultItem{
			ID:            vID,
			Name:          name,
			Type:          vType,
			Username:      username,
			Remark:        remark,
			Fingerprint:   fingerprint,
			RefCount:      refCount,
			HasPassphrase: hasPassphrase,
			CreatedAt:     createdAt,
			UpdatedAt:     updatedAt,
		})
	}
	return items, rows.Err()
}

// detectPassphrase inspects decrypted plaintext to determine whether a
// passphrase segment is present and non-empty.
func (s *sqliteVaultStore) detectPassphrase(decrypted, credType string) bool {
	switch credType {
	case model.VaultTypePrivateKey:
		parts := strings.SplitN(decrypted, "\x00", 2)
		return len(parts) == 2 && parts[1] != ""
	case model.VaultTypeSSHCertificate:
		parts := strings.SplitN(decrypted, "\x00", 3)
		return len(parts) == 3 && parts[2] != ""
	}
	return false
}
