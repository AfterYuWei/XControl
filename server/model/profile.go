package model

import "time"

type Profile struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Host       string    `json:"host"`
	Port       int       `json:"port"`
	Username   string    `json:"username"`
	AuthType   string    `json:"auth_type"` // password | key | agent
	VaultID    string    `json:"vault_id,omitempty"`
	GroupID    string    `json:"group_id,omitempty"`
	Tags       []string  `json:"tags"`
	Options    string    `json:"options,omitempty"` // JSON string
	Note       string    `json:"note,omitempty"`
	SortOrder  int       `json:"sort_order"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type ProfileCreateRequest struct {
	Name     string   `json:"name"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Username string   `json:"username"`
	AuthType string   `json:"auth_type"`
	Password string   `json:"password,omitempty"`
	PrivKey  string   `json:"private_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	GroupID  string   `json:"group_id,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Options  string   `json:"options,omitempty"`
	Note     string   `json:"note,omitempty"`
}

type ProfileUpdateRequest struct {
	Name       *string  `json:"name,omitempty"`
	Host       *string  `json:"host,omitempty"`
	Port       *int     `json:"port,omitempty"`
	Username   *string  `json:"username,omitempty"`
	AuthType   *string  `json:"auth_type,omitempty"`
	VaultID    *string  `json:"vault_id,omitempty"`
	Password   *string  `json:"password,omitempty"`
	PrivKey    *string  `json:"private_key,omitempty"`
	Passphrase *string  `json:"passphrase,omitempty"`
	GroupID    *string  `json:"group_id,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Options    *string  `json:"options,omitempty"`
	Note       *string  `json:"note,omitempty"`
}

type ProfileTestResult struct {
	Success    bool   `json:"success"`
	Message    string `json:"message"`
	LatencyMs  int64  `json:"latency_ms"`
	ServerInfo string `json:"server_info,omitempty"`
}
