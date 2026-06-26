package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
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

func (s *sqliteVaultStore) Store(cred *model.Credential, credType string) (string, error) {
	var plaintext string
	var fingerprint string

	switch credType {
	case "password":
		plaintext = cred.Password
		h := sha256.Sum256([]byte(cred.Password))
		fingerprint = hex.EncodeToString(h[:8])
	case "private_key":
		plaintext = cred.PrivKey
		if cred.Passphrase != "" {
			plaintext += "\x00" + cred.Passphrase
		}
		h := sha256.Sum256([]byte(cred.PrivKey))
		fingerprint = hex.EncodeToString(h[:8])
	default:
		plaintext = cred.Password
	}

	encrypted, err := s.encryptor.Encrypt(plaintext)
	if err != nil {
		return "", err
	}

	id := uuid.New().String()
	_, err = s.db.Exec(`INSERT INTO vault (id, type, data, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, credType, encrypted, fingerprint, time.Now())
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

	cred := &model.Credential{}
	switch credType {
	case "password":
		cred.Password = decrypted
	case "private_key":
		for i, ch := range decrypted {
			if ch == '\x00' {
				cred.PrivKey = decrypted[:i]
				cred.Passphrase = decrypted[i+1:]
				break
			}
		}
		if cred.PrivKey == "" {
			cred.PrivKey = decrypted
		}
	}

	return cred, nil
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
