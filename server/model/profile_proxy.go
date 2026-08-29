package model

import (
	"encoding/json"
	"strings"
)

const (
	ProxyTypeDirect = "direct"
	ProxyTypeSOCKS5 = "socks5"
	ProxyTypeHTTP   = "http"
	ProxyTypeJump   = "jump"
)

// ProxyConfig is the public, non-secret proxy configuration returned with a
// Profile. Password material is stored separately and represented only by
// HasPassword.
type ProxyConfig struct {
	Type          string `json:"type"`
	Host          string `json:"host,omitempty"`
	Port          int    `json:"port,omitempty"`
	Username      string `json:"username,omitempty"`
	JumpProfileID string `json:"jump_profile_id,omitempty"`
	HasPassword   bool   `json:"has_password,omitempty"`
}

// ProxyInput is accepted by profile create/update/test APIs. Password is a
// pointer so update can distinguish "not supplied" (preserve) from an
// explicit empty string (clear).
type ProxyInput struct {
	Type          string  `json:"type"`
	Host          string  `json:"host,omitempty"`
	Port          int     `json:"port,omitempty"`
	Username      string  `json:"username,omitempty"`
	Password      *string `json:"password,omitempty"`
	JumpProfileID string  `json:"jump_profile_id,omitempty"`
}

func DirectProxyConfig() ProxyConfig {
	return ProxyConfig{Type: ProxyTypeDirect}
}

// ParseProxyOptions extracts options.proxy without exposing or mutating other
// advanced profile options.
func ParseProxyOptions(raw string) ProxyConfig {
	proxy := DirectProxyConfig()
	if strings.TrimSpace(raw) == "" {
		return proxy
	}
	var options struct {
		Proxy *ProxyConfig `json:"proxy"`
	}
	if json.Unmarshal([]byte(raw), &options) != nil || options.Proxy == nil {
		return proxy
	}
	proxy = *options.Proxy
	if proxy.Type == "" {
		proxy.Type = ProxyTypeDirect
	}
	proxy.HasPassword = false
	return proxy
}

// WithProxyOptions merges proxy into the existing options object and keeps all
// unrelated keys, including the stored host-key fingerprint.
func WithProxyOptions(raw string, proxy ProxyConfig) (string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	options := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		return "", err
	}
	if proxy.Type == "" || proxy.Type == ProxyTypeDirect {
		delete(options, "proxy")
	} else {
		proxy.HasPassword = false
		options["proxy"] = proxy
	}
	encoded, err := json.Marshal(options)
	return string(encoded), err
}
