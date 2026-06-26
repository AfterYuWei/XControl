package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/yuweinfo/xcontrol/config"
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/gateway"
	"github.com/yuweinfo/xcontrol/store"
)

func main() {
	// Load config
	cfg := config.Load()

	// Setup logger
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	slog.Info("starting xcontrol server", "port", cfg.Port)

	// Initialize database
	db, err := store.InitDB(cfg.DBPath)
	if err != nil {
		slog.Error("failed to init database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Initialize encryptor
	encryptor, err := crypto.NewEncryptor(cfg.KeyPath)
	if err != nil {
		slog.Error("failed to init encryptor", "error", err)
		os.Exit(1)
	}

	// Create router
	handler := gateway.NewRouter(db, encryptor, WebFS())

	// Start server
	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("server listening", "addr", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
