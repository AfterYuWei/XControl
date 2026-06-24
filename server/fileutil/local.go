package fileutil

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// LocalBackend implements FileBackend using the local filesystem.
// API paths are POSIX-style; they are converted to OS-native paths internally.
// On Windows a path like "/C:/Users" maps to "C:\Users"; "/web/src" maps to
// "<currentDrive>:\web\src". On Unix, paths map directly.
type LocalBackend struct{}

// NewLocalBackend creates a local filesystem backend.
func NewLocalBackend() *LocalBackend {
	return &LocalBackend{}
}

// posixToOS converts a POSIX API path to an OS-native filesystem path.
func posixToOS(posixPath string) string {
	p := CleanPath(posixPath)

	if runtime.GOOS == "windows" {
		// "/C:/Users" → "C:\Users"
		if len(p) > 2 && p[0] == '/' && p[2] == ':' {
			return filepath.FromSlash(p[1:])
		}
		// "/web/src" → "<currentDrive>:\web\src"
		if p == "/" {
			// Root: return current drive root
			if cwd, err := os.Getwd(); err == nil {
				return filepath.VolumeName(cwd) + string(filepath.Separator)
			}
			return "C:\\"
		}
		return filepath.FromSlash(p)
	}

	// Unix: direct mapping
	if p == "/" {
		return "/"
	}
	return p
}

// osToPosix converts an OS-native path back to POSIX style.
func osToPosix(osPath string) string {
	if runtime.GOOS == "windows" {
		// "C:\Users" → "/C:/Users"
		vol := filepath.VolumeName(osPath)
		rest := strings.TrimPrefix(osPath, vol)
		posix := filepath.ToSlash(rest)
		if vol != "" {
			// vol is like "C:"
			return "/" + vol + posix
		}
		return posix
	}
	return filepath.ToSlash(osPath)
}

func (b *LocalBackend) List(ctx context.Context, p string) ([]FileInfo, error) {
	osPath := posixToOS(p)
	entries, err := os.ReadDir(osPath)
	if err != nil {
		return nil, mapOSErr(err)
	}
	result := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		childPath := joinPosix(p, e.Name())
		result = append(result, FileInfo{
			Name:    e.Name(),
			Path:    childPath,
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Mode:    info.Mode().String(),
		})
	}
	return result, nil
}

func (b *LocalBackend) Stat(ctx context.Context, p string) (FileInfo, error) {
	osPath := posixToOS(p)
	info, err := os.Stat(osPath)
	if err != nil {
		return FileInfo{}, mapOSErr(err)
	}
	return FileInfo{
		Name:    filepath.Base(osPath),
		Path:    CleanPath(p),
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime(),
		Mode:    info.Mode().String(),
	}, nil
}

func (b *LocalBackend) Mkdir(ctx context.Context, p string) error {
	osPath := posixToOS(p)
	if err := os.Mkdir(osPath, 0o755); err != nil {
		return mapOSErr(err)
	}
	return nil
}

func (b *LocalBackend) MkdirP(ctx context.Context, p string) error {
	osPath := posixToOS(p)
	if err := os.MkdirAll(osPath, 0o755); err != nil {
		return mapOSErr(err)
	}
	return nil
}

func (b *LocalBackend) Remove(ctx context.Context, p string) error {
	osPath := posixToOS(p)
	if err := os.Remove(osPath); err != nil {
		return mapOSErr(err)
	}
	return nil
}

func (b *LocalBackend) Rename(ctx context.Context, oldPath, newPath string) error {
	oldOS := posixToOS(oldPath)
	newOS := posixToOS(newPath)
	if err := os.Rename(oldOS, newOS); err != nil {
		return mapOSErr(err)
	}
	return nil
}

func (b *LocalBackend) OpenRead(ctx context.Context, p string) (io.ReadCloser, error) {
	osPath := posixToOS(p)
	f, err := os.Open(osPath)
	if err != nil {
		return nil, mapOSErr(err)
	}
	return f, nil
}

func (b *LocalBackend) OpenWrite(ctx context.Context, p string) (io.WriteCloser, error) {
	osPath := posixToOS(p)
	f, err := os.Create(osPath)
	if err != nil {
		return nil, mapOSErr(err)
	}
	return f, nil
}

func (b *LocalBackend) Close() error { return nil }

// joinPosix joins a parent POSIX path with a child name.
func joinPosix(parent, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return parent + "/" + name
}

// mapOSErr converts os errors to sentinel error types where possible.
func mapOSErr(err error) error {
	if err == nil {
		return nil
	}
	if os.IsNotExist(err) {
		return ErrNotFound
	}
	if os.IsPermission(err) {
		return ErrPermission
	}
	if os.IsExist(err) {
		return ErrAlreadyExists
	}
	return err
}
