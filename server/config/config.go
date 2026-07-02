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
		Port:     getEnvInt("XCONTROL_PORT", 9090),
		DBPath:   getEnvStr("XCONTROL_DB_PATH", defaultDBPath),
		KeyPath:  getEnvStr("XCONTROL_KEY_PATH", defaultKeyPath),
		LogLevel: getEnvStr("XCONTROL_LOG_LEVEL", "debug"),
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
