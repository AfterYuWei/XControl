package config

import (
	"reflect"
	"testing"
)

func TestLoadDefaultsToLoopback(t *testing.T) {
	t.Setenv("XCONTROL_HOST", "")
	cfg := Load()
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("host = %q, want loopback", cfg.Host)
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	t.Setenv("XCONTROL_ALLOWED_ORIGINS", "http://localhost:5173, https://debug.example ,")
	cfg := Load()
	want := []string{"http://localhost:5173", "https://debug.example"}
	if !reflect.DeepEqual(cfg.AllowedOrigins, want) {
		t.Fatalf("allowed origins = %#v, want %#v", cfg.AllowedOrigins, want)
	}
}
