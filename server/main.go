package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

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
	shutdownRequested := make(chan struct{}, 1)
	handler, runtime := gateway.NewRouter(db, encryptor, WebFS(), syncMgr, gateway.Options{
		AllowedOrigins: cfg.AllowedOrigins,
		AccessToken:    cfg.AccessToken,
		RequestShutdown: func() {
			select {
			case shutdownRequested <- struct{}{}:
			default:
			}
		},
	})
	defer runtime.Close()

	// Start server
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	slog.Info("server listening", "addr", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()

	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	select {
	case <-signalCtx.Done():
		slog.Info("server shutdown requested", "source", "signal")
	case <-shutdownRequested:
		slog.Info("server shutdown requested", "source", "desktop")
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "error", err)
		}
		return
	}

	syncMgr.ShutdownBackup()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
		_ = server.Close()
	}
	runtime.Close()
}
