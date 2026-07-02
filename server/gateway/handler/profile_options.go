package handler

import (
	"encoding/json"
	"strings"
)

func profileHostKeyFingerprint(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var options map[string]any
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		return ""
	}
	if value, ok := options["host_key_fingerprint"].(string); ok {
		return value
	}
	return ""
}

func withProfileHostKeyFingerprint(raw, fingerprint string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	options := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		return "", err
	}
	if fingerprint == "" {
		delete(options, "host_key_fingerprint")
	} else {
		options["host_key_fingerprint"] = fingerprint
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
