package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port     int
	DBPath   string
	KeyPath  string
	LogLevel string
}

func Load() *Config {
	return &Config{
		Port:     getEnvInt("SSHX_PORT", 9090),
		DBPath:   getEnvStr("SSHX_DB_PATH", "./data/sshx.db"),
		KeyPath:  getEnvStr("SSHX_KEY_PATH", "./data/key"),
		LogLevel: getEnvStr("SSHX_LOG_LEVEL", "info"),
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
