package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/yuweinfo/xcontrol/config"
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/gateway"
	"github.com/yuweinfo/xcontrol/store"
	xcsync "github.com/yuweinfo/xcontrol/sync"
)

func main() {
	// Load config
	cfg := config.Load()
	SetDevDefaults(cfg) // 开发模式覆盖默认配置

	// Setup logger
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	slog.Info("starting xcontrol server", "port", cfg.Port, "log_level", cfg.LogLevel)
	slog.Debug("debug logging enabled", "port", cfg.Port, "db_path", cfg.DBPath, "key_path", cfg.KeyPath)

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

	// Initialize sync manager (local version control)
	backupDir := filepath.Join(filepath.Dir(cfg.DBPath), "backups")
	syncMgr, err := xcsync.NewManager(store.NewBackupStore(db, encryptor), store.NewSyncStore(db, encryptor), store.NewSyncProviderStore(db, encryptor), backupDir)
	if err != nil {
		slog.Error("failed to init sync manager", "error", err)
		os.Exit(1)
	}
	syncCtx, syncCancel := context.WithCancel(context.Background())
	defer syncCancel()
	syncMgr.Start(syncCtx)
	defer syncMgr.Stop()

	// Create router
	handler := gateway.NewRouter(db, encryptor, WebFS(), syncMgr)

	// Start server
	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("server listening", "addr", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
