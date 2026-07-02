package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

// EncodeInlineCredential encrypts a profile-owned credential payload.
func EncodeInlineCredential(encryptor *crypto.Encryptor, cred *model.Credential) (string, error) {
	if encryptor == nil || cred == nil {
		return "", nil
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		return "", fmt.Errorf("marshal inline credential: %w", err)
	}
	if string(raw) == "{}" {
		return "", nil
	}
	encrypted, err := encryptor.Encrypt(string(raw))
	if err != nil {
		return "", fmt.Errorf("encrypt inline credential: %w", err)
	}
	return encrypted, nil
}

// DecodeInlineCredential decrypts a profile-owned credential payload.
func DecodeInlineCredential(encryptor *crypto.Encryptor, encoded string) (*model.Credential, error) {
	if encryptor == nil || encoded == "" {
		return &model.Credential{}, nil
	}
	decrypted, err := encryptor.Decrypt(encoded)
	if err != nil {
		return nil, fmt.Errorf("decrypt inline credential: %w", err)
	}
	cred := &model.Credential{}
	if err := json.Unmarshal([]byte(decrypted), cred); err != nil {
		return nil, fmt.Errorf("unmarshal inline credential: %w", err)
	}
	return cred, nil
}

// BackfillProfileInlineCredentials migrates legacy non-vault profiles whose
// credentials were implicitly stored in the vault into profile-owned encrypted
// storage, so Vault references only represent explicit Vault usage.
func BackfillProfileInlineCredentials(db *sql.DB, encryptor *crypto.Encryptor) error {
	if db == nil || encryptor == nil {
		return nil
	}

	rows, err := db.Query(`
		SELECT p.id, p.auth_type, p.vault_id, v.type, v.data
		FROM profiles p
		JOIN vault v ON v.id = p.vault_id
		WHERE p.auth_type != 'vault'
		  AND p.vault_id != ''
		  AND (p.inline_credential = '' OR p.inline_credential IS NULL)
	`)
	if err != nil {
		return fmt.Errorf("query legacy inline credentials: %w", err)
	}
	defer rows.Close()

	type legacyProfile struct {
		id       string
		authType string
		vaultID  string
		vType    string
		data     string
	}

	var profiles []legacyProfile
	for rows.Next() {
		var item legacyProfile
		if err := rows.Scan(&item.id, &item.authType, &item.vaultID, &item.vType, &item.data); err != nil {
			return fmt.Errorf("scan legacy inline credential: %w", err)
		}
		profiles = append(profiles, item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate legacy inline credentials: %w", err)
	}

	for _, p := range profiles {
		decrypted, err := encryptor.Decrypt(p.data)
		if err != nil {
			return fmt.Errorf("decrypt legacy vault credential for profile %s: %w", p.id, err)
		}

		cred := decodePlaintext(decrypted, p.vType)
		inlineCredential, err := EncodeInlineCredential(encryptor, cred)
		if err != nil {
			return fmt.Errorf("encode inline credential for profile %s: %w", p.id, err)
		}

		if _, err := db.Exec(
			`UPDATE profiles SET inline_credential = ?, vault_id = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
			inlineCredential, p.id,
		); err != nil {
			return fmt.Errorf("migrate profile %s inline credential: %w", p.id, err)
		}

		var refs int
		if err := db.QueryRow(`SELECT COUNT(*) FROM profiles WHERE auth_type = 'vault' AND vault_id = ?`, p.vaultID).Scan(&refs); err != nil {
			return fmt.Errorf("count vault references for %s: %w", p.vaultID, err)
		}
		if refs == 0 {
			if _, err := db.Exec(`DELETE FROM vault WHERE id = ?`, p.vaultID); err != nil {
				return fmt.Errorf("delete migrated legacy vault %s: %w", p.vaultID, err)
			}
		}
	}

	return nil
}
