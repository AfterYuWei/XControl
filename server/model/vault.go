package model

import "time"

// Vault type constants.
const (
	VaultTypePassword       = "password"
	VaultTypePrivateKey     = "private_key"
	VaultTypeSSHCertificate = "ssh_certificate"
)

type Vault struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Type        string    `json:"type"` // password | private_key | ssh_certificate
	Data        string    `json:"data"`
	Remark      string    `json:"remark"`
	Fingerprint string    `json:"fingerprint,omitempty"`
	RefCount    int       `json:"ref_count,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Credential struct {
	Password   string `json:"password,omitempty"`
	PrivKey    string `json:"private_key,omitempty"`
	PublicKey  string `json:"public_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	Cert       string `json:"certificate,omitempty"` // SSH certificate (OpenSSH format)
}

// VaultItem is the list/detail response payload without ciphertext.
type VaultItem struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Type          string    `json:"type"`
	Username      string    `json:"username"`
	Remark        string    `json:"remark"`
	Fingerprint   string    `json:"fingerprint"`
	RefCount      int       `json:"ref_count"`
	HasPassphrase bool      `json:"has_passphrase"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// VaultListFilter controls vault list query.
type VaultListFilter struct {
	Type string // empty = all
	Q    string // name/remark substring
}

// ProfileRef is a lightweight profile reference for vault deletion checks.
type ProfileRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
