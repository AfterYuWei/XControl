package model

import "time"

type Profile struct {
	ID               string      `json:"id"`
	Name             string      `json:"name"`
	Host             string      `json:"host"`
	Port             int         `json:"port"`
	Username         string      `json:"username"`
	AuthType         string      `json:"auth_type"`      // password | key | agent | vault
	Icon             string      `json:"icon,omitempty"` // line-icon key, e.g. "server", "database"
	VaultID          string      `json:"vault_id,omitempty"`
	InlineCredential string      `json:"-"`
	ProxyCredential  string      `json:"-"`
	Proxy            ProxyConfig `json:"proxy"`
	GroupID          string      `json:"group_id,omitempty"`
	Tags             []string    `json:"tags"`
	Options          string      `json:"options,omitempty"` // JSON string
	Note             string      `json:"note,omitempty"`
	SortOrder        int         `json:"sort_order"`
	LastUsedAt       *time.Time  `json:"last_used_at,omitempty"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`
}

type ProfileCreateRequest struct {
	Name       string      `json:"name"`
	Host       string      `json:"host"`
	Port       int         `json:"port"`
	Username   string      `json:"username"`
	AuthType   string      `json:"auth_type"`
	Icon       string      `json:"icon,omitempty"`
	VaultID    string      `json:"vault_id,omitempty"`
	Password   string      `json:"password,omitempty"`
	PrivKey    string      `json:"private_key,omitempty"`
	Passphrase string      `json:"passphrase,omitempty"`
	Proxy      *ProxyInput `json:"proxy,omitempty"`
	GroupID    string      `json:"group_id,omitempty"`
	Tags       []string    `json:"tags,omitempty"`
	Options    string      `json:"options,omitempty"`
	Note       string      `json:"note,omitempty"`
}

type ProfileUpdateRequest struct {
	Name             *string     `json:"name,omitempty"`
	Host             *string     `json:"host,omitempty"`
	Port             *int        `json:"port,omitempty"`
	Username         *string     `json:"username,omitempty"`
	AuthType         *string     `json:"auth_type,omitempty"`
	Icon             *string     `json:"icon,omitempty"`
	VaultID          *string     `json:"vault_id,omitempty"`
	InlineCredential *string     `json:"-"`
	Password         *string     `json:"password,omitempty"`
	PrivKey          *string     `json:"private_key,omitempty"`
	Passphrase       *string     `json:"passphrase,omitempty"`
	Proxy            *ProxyInput `json:"proxy,omitempty"`
	ProxyCredential  *string     `json:"-"`
	GroupID          *string     `json:"group_id,omitempty"`
	Tags             []string    `json:"tags,omitempty"`
	Options          *string     `json:"options,omitempty"`
	Note             *string     `json:"note,omitempty"`
}

type ProfileTestResult struct {
	Success    bool               `json:"success"`
	Message    string             `json:"message"`
	LatencyMs  int64              `json:"latency_ms"`
	ServerInfo string             `json:"server_info,omitempty"`
	Stages     []ProfileTestStage `json:"stages"`
}

type ProfileTestStage struct {
	Stage            string `json:"stage"`
	Status           string `json:"status"`
	Message          string `json:"message"`
	ProfileID        string `json:"profile_id,omitempty"`
	ProfileName      string `json:"profile_name,omitempty"`
	LatencyMs        int64  `json:"latency_ms,omitempty"`
	KnownFingerprint string `json:"known_fingerprint,omitempty"`
	Fingerprint      string `json:"fingerprint,omitempty"`
}
