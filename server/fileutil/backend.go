// Package fileutil defines a backend-agnostic file operations interface and
// provides reusable utilities (recursive delete, directory walk, batch mkdir,
// copy) that work across local filesystem and SFTP. Implementations only need
// to supply the primitive operations; higher-level logic is shared.
package fileutil

import (
	"context"
	"io"
	"time"
)

// FileInfo holds metadata about a file or directory.
type FileInfo struct {
	Name    string    // base name
	Path    string    // absolute POSIX path (no trailing slash)
	IsDir   bool      // true for directories
	Size    int64     // bytes; 0 for directories
	ModTime time.Time // last modification time
	Mode    string    // permission string e.g. "rwxr-xr-x" (optional)
}

// FileBackend is the abstraction that both local filesystem and SFTP
// implement. All methods accept a context for cancellation/timeout.
// Paths are always POSIX-style (forward slashes); local backends convert
// internally.
type FileBackend interface {
	// List returns the entries in a directory.
	List(ctx context.Context, path string) ([]FileInfo, error)
	// Stat returns metadata for a single path.
	Stat(ctx context.Context, path string) (FileInfo, error)
	// Mkdir creates a single directory (non-recursive).
	Mkdir(ctx context.Context, path string) error
	// MkdirP creates a directory and all intermediate parents.
	MkdirP(ctx context.Context, path string) error
	// Remove deletes a file or empty directory.
	Remove(ctx context.Context, path string) error
	// Rename moves/renames a file or directory.
	Rename(ctx context.Context, oldPath, newPath string) error
	// OpenRead opens a file for reading. The caller must close the reader.
	OpenRead(ctx context.Context, path string) (io.ReadCloser, error)
	// OpenWrite opens a file for writing (truncates if exists). The caller
	// must close the writer.
	OpenWrite(ctx context.Context, path string) (io.WriteCloser, error)
	// Close releases any resources held by the backend.
	Close() error
}

// BackendProvider is an optional interface that protocol drivers can implement
// to expose a FileBackend. Handlers use a type assertion to detect this.
type BackendProvider interface {
	FileBackend() FileBackend
}
