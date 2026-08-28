package handler

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/yuweinfo/xcontrol/fileutil"
	"github.com/yuweinfo/xcontrol/model"
)

func apiTestPath(p string) string {
	p = filepath.ToSlash(p)
	if runtime.GOOS == "windows" {
		return "/" + p
	}
	return p
}

func TestTransferDirPreserve(t *testing.T) {
	root := t.TempDir()
	sourceDir := filepath.Join(root, "source", "project")
	destDir := filepath.Join(root, "target")
	if err := os.MkdirAll(filepath.Join(sourceDir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "nested", "config.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	backend := fileutil.NewLocalBackend()
	session := &SftpSession{Backend: backend}
	var transferred atomic.Int64
	h := &SftpHandler{}
	if err := h.transferDirPreserve(
		context.Background(), session, session,
		apiTestPath(sourceDir), apiTestPath(destDir),
		model.ConflictAsk, &transferred,
	); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(destDir, "project", "nested", "config.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Fatalf("copied content = %q", got)
	}
	if transferred.Load() != 5 {
		t.Fatalf("transferred = %d, want 5", transferred.Load())
	}
}

func TestPathWithinUsesPathBoundaries(t *testing.T) {
	if !pathWithin("/root/project/logs", "/root/project") {
		t.Fatal("expected descendant path to match")
	}
	if pathWithin("/root/project-old", "/root/project") {
		t.Fatal("prefix-only sibling must not match")
	}
}

func TestTransferDirArchiveCreatesTarGz(t *testing.T) {
	root := t.TempDir()
	sourceDir := filepath.Join(root, "source", "logs")
	destDir := filepath.Join(root, "target")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "app.log"), []byte("line"), 0o644); err != nil {
		t.Fatal(err)
	}

	backend := fileutil.NewLocalBackend()
	session := &SftpSession{Backend: backend}
	h := &SftpHandler{transfers: &TransferManager{tmpDir: t.TempDir()}}
	entry := &transferEntry{task: &model.TransferTask{ID: "archive-test"}}
	var transferred atomic.Int64
	if err := h.transferDirAsTarGz(
		context.Background(), entry, session, session,
		apiTestPath(sourceDir), apiTestPath(destDir),
		model.ConflictAsk, &transferred,
	); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(destDir, "logs.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() == 0 {
		t.Fatal("archive is empty")
	}
}
