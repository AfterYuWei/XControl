package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"
)

// KDFParams describes the Argon2id parameters used to derive the backup
// encryption key from a user-provided password. The params are stored inside
// the backup file so future default-strength changes stay backward compatible.
type KDFParams struct {
	Algo    string `json:"algo"` // always "argon2id"
	Salt    string `json:"salt"` // base64, 16 bytes
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"`  // KiB
	Threads uint8  `json:"threads"`
}

// Default KDF parameters (OWASP-ish for interactive use).
const (
	kdfSaltLen   = 16
	kdfKeyLen    = 32
	kdfTime      = 3
	kdfMemory    = 64 * 1024 // 64 MiB
	kdfThreads   = 2
	kdfMaxMemory = 1 << 20 // 1 GiB, upper bound to guard against DoS via crafted files
)

// NewKDFParams generates fresh default KDF params (random salt).
func NewKDFParams() (*KDFParams, error) {
	salt := make([]byte, kdfSaltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	return &KDFParams{
		Algo:    "argon2id",
		Salt:    base64.StdEncoding.EncodeToString(salt),
		Time:    kdfTime,
		Memory:  kdfMemory,
		Threads: kdfThreads,
	}, nil
}

// Validate checks KDF params read from a backup file.
func (p *KDFParams) Validate() error {
	if p.Algo != "argon2id" {
		return fmt.Errorf("unsupported kdf algo: %s", p.Algo)
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil || len(salt) == 0 {
		return fmt.Errorf("invalid kdf salt")
	}
	if p.Time == 0 || p.Time > 100 {
		return fmt.Errorf("invalid kdf time: %d", p.Time)
	}
	if p.Memory == 0 || p.Memory > kdfMaxMemory {
		return fmt.Errorf("invalid kdf memory: %d", p.Memory)
	}
	if p.Threads == 0 || p.Threads > 16 {
		return fmt.Errorf("invalid kdf threads: %d", p.Threads)
	}
	return nil
}

// DeriveKeyArgon2id derives a 32-byte key from password using the given params.
func DeriveKeyArgon2id(password string, p *KDFParams) ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil {
		return nil, fmt.Errorf("decode salt: %w", err)
	}
	return argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, kdfKeyLen), nil
}

// EncryptWithKey encrypts plaintext with AES-256-GCM using an explicit key.
// Output layout: Base64(Nonce ∥ Ciphertext ∥ AuthTag), aad binds the
// ciphertext to its context (e.g. "xcontrol-backup:1").
func EncryptWithKey(key, plaintext, aad []byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	ciphertext := gcm.Seal(nonce, nonce, plaintext, aad)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptWithKey reverses EncryptWithKey.
func DecryptWithKey(key, aad []byte, encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, body := raw[:nonceSize], raw[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, body, aad)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plaintext, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("invalid key length: %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	return gcm, nil
}
