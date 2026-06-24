package fileutil

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/pkg/sftp"
)

// SftpBackend implements FileBackend using an SFTP client.
type SftpBackend struct {
	client *sftp.Client
}

// NewSftpBackend wraps an existing sftp.Client.
func NewSftpBackend(client *sftp.Client) *SftpBackend {
	return &SftpBackend{client: client}
}

func (b *SftpBackend) List(ctx context.Context, p string) ([]FileInfo, error) {
	if b.client == nil {
		return nil, ErrNotConnected
	}
	p = CleanPath(p)
	entries, err := b.client.ReadDir(p)
	if err != nil {
		return nil, mapSftpErr(err)
	}
	result := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		childPath := joinPosix(p, e.Name())
		result = append(result, FileInfo{
			Name:    e.Name(),
			Path:    childPath,
			IsDir:   e.IsDir(),
			Size:    e.Size(),
			ModTime: e.ModTime(),
			Mode:    e.Mode().String(),
		})
	}
	return result, nil
}

func (b *SftpBackend) Stat(ctx context.Context, p string) (FileInfo, error) {
	if b.client == nil {
		return FileInfo{}, ErrNotConnected
	}
	p = CleanPath(p)
	info, err := b.client.Stat(p)
	if err != nil {
		return FileInfo{}, mapSftpErr(err)
	}
	return FileInfo{
		Name:    info.Name(),
		Path:    p,
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime(),
		Mode:    info.Mode().String(),
	}, nil
}

func (b *SftpBackend) Mkdir(ctx context.Context, p string) error {
	if b.client == nil {
		return ErrNotConnected
	}
	p = CleanPath(p)
	if err := b.client.Mkdir(p); err != nil {
		return mapSftpErr(err)
	}
	return nil
}

func (b *SftpBackend) MkdirP(ctx context.Context, p string) error {
	if b.client == nil {
		return ErrNotConnected
	}
	p = CleanPath(p)
	if err := b.client.MkdirAll(p); err != nil {
		return mapSftpErr(err)
	}
	return nil
}

func (b *SftpBackend) Remove(ctx context.Context, p string) error {
	if b.client == nil {
		return ErrNotConnected
	}
	p = CleanPath(p)
	if err := b.client.Remove(p); err != nil {
		return mapSftpErr(err)
	}
	return nil
}

func (b *SftpBackend) Rename(ctx context.Context, oldPath, newPath string) error {
	if b.client == nil {
		return ErrNotConnected
	}
	if err := b.client.Rename(CleanPath(oldPath), CleanPath(newPath)); err != nil {
		return mapSftpErr(err)
	}
	return nil
}

func (b *SftpBackend) OpenRead(ctx context.Context, p string) (io.ReadCloser, error) {
	if b.client == nil {
		return nil, ErrNotConnected
	}
	p = CleanPath(p)
	f, err := b.client.Open(p)
	if err != nil {
		return nil, mapSftpErr(err)
	}
	return f, nil
}

func (b *SftpBackend) OpenWrite(ctx context.Context, p string) (io.WriteCloser, error) {
	if b.client == nil {
		return nil, ErrNotConnected
	}
	p = CleanPath(p)
	f, err := b.client.Create(p)
	if err != nil {
		return nil, mapSftpErr(err)
	}
	return f, nil
}

func (b *SftpBackend) Close() error {
	if b.client != nil {
		return b.client.Close()
	}
	return nil
}

// mapSftpErr converts SFTP status errors to sentinel errors. The pkg/sftp
// library is designed so that os.IsNotExist and os.IsPermission work on
// returned errors.
func mapSftpErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sftp.ErrSshFxNoSuchFile) || os.IsNotExist(err) {
		return ErrNotFound
	}
	if errors.Is(err, sftp.ErrSshFxPermissionDenied) || os.IsPermission(err) {
		return ErrPermission
	}
	if errors.Is(err, sftp.ErrSshFxFailure) {
		msg := err.Error()
		if contains(msg, "exists") || contains(msg, "Failure") {
			return ErrAlreadyExists
		}
	}
	return err
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || indexOf(s, substr) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
