package model

import "time"

type Vault struct {
	ID          string    `json:"id"`
	Type        string    `json:"type"` // password | private_key
	Data        string    `json:"data"`
	Fingerprint string    `json:"fingerprint,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type Credential struct {
	Password   string `json:"password,omitempty"`
	PrivKey    string `json:"private_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}
