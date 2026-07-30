package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Host           string
	Port           int
	DBPath         string
	KeyPath        string
	LogLevel       string
	AllowedOrigins []string
	AccessToken    string
}

func Load() *Config {
	return &Config{
		Host:           getEnvStr("XCONTROL_HOST", defaultHost),
		Port:           getEnvInt("XCONTROL_PORT", 9090),
		DBPath:         getEnvStr("XCONTROL_DB_PATH", defaultDBPath),
		KeyPath:        getEnvStr("XCONTROL_KEY_PATH", defaultKeyPath),
		LogLevel:       getEnvStr("XCONTROL_LOG_LEVEL", "debug"),
		AllowedOrigins: getEnvList("XCONTROL_ALLOWED_ORIGINS", defaultAllowedOrigins),
		AccessToken:    getEnvStr("XCONTROL_ACCESS_TOKEN", ""),
	}
}

func getEnvStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func getEnvList(key, fallback string) []string {
	raw := getEnvStr(key, fallback)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			values = append(values, value)
		}
	}
	return values
}
