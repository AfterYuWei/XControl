// Package connpool provides a global SSH/SFTP connection pool with reference
// counting. Each unique server (host:port:username) shares a single SSH
// connection. The pool exposes two independent resource channels:
//
//   - CommandExecutor (SSH exec) — used for remote command execution
//   - FileBackend (SFTP subsystem) — used for file operations
//
// Each channel has its own reference count. The underlying SSH connection is
// closed only when both counts reach zero.
package connpool

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	gossh "golang.org/x/crypto/ssh"
	"github.com/pkg/sftp"

	"github.com/yuweinfo/xcontrol/fileutil"
	"github.com/yuweinfo/xcontrol/protocol"
)

// poolKey returns the cache key for a server address.
func poolKey(host string, port int, username string) string {
	if port == 0 {
		port = 22
	}
	return fmt.Sprintf("%s:%d:%s", host, port, username)
}

// Entry represents a shared connection to a single server. It holds both an
// SSH driver (for command execution) and an SFTP backend (for file operations),
// each with independent reference counts.
type Entry struct {
	Driver  protocol.Driver
	Exec    protocol.CommandExecutor
	Backend fileutil.FileBackend

	sshRef  int // CommandExecutor consumers
	sftpRef int // FileBackend consumers

	mu  sync.RWMutex // protects ref counts AND serializes Backend access
	key string
	pool *Pool
}

// Pool manages all cached connections. It is safe for concurrent use.
type Pool struct {
	entries map[string]*Entry
	mu      sync.Mutex
	pm      *protocol.Manager
}

// Init creates and returns the global connection pool. Must be called once
// at startup (in router.go) with the protocol.Manager.
func Init(pm *protocol.Manager) *Pool {
	return &Pool{
		entries: make(map[string]*Entry),
		pm:      pm,
	}
}

// Acquire obtains a shared connection, creating one if necessary.
// Both sshRef and sftpRef are incremented. The caller must call
// entry.ReleaseSSH() and entry.ReleaseSFTP() when done.
func (p *Pool) Acquire(ctx context.Context, opts protocol.DriverOpts) (*Entry, error) {
	return p.acquire(ctx, opts, true, true)
}

// AcquireSFTP increments only sftpRef. Creates the connection if needed.
func (p *Pool) AcquireSFTP(ctx context.Context, opts protocol.DriverOpts) (*Entry, error) {
	return p.acquire(ctx, opts, false, true)
}

// AcquireExec increments only sshRef. Creates the connection if needed.
func (p *Pool) AcquireExec(ctx context.Context, opts protocol.DriverOpts) (*Entry, error) {
	return p.acquire(ctx, opts, true, false)
}

func (p *Pool) acquire(ctx context.Context, opts protocol.DriverOpts, needSSH, needSFTP bool) (*Entry, error) {
	key := poolKey(opts.Host, opts.Port, opts.Username)

	p.mu.Lock()
	entry, exists := p.entries[key]
	if exists {
		p.mu.Unlock()
		entry.mu.Lock()
		if needSSH {
			entry.sshRef++
		}
		if needSFTP {
			entry.sftpRef++
		}
		entry.mu.Unlock()
		slog.Debug("connpool: reused connection", "key", key, "sshRef", entry.sshRef, "sftpRef", entry.sftpRef)
		return entry, nil
	}

	// Create a placeholder so concurrent Acquire for the same key sees it.
	entry = &Entry{key: key, pool: p}
	p.entries[key] = entry
	p.mu.Unlock()

	// Create SSH connection outside the pool lock.
	driver, err := p.pm.Create("ssh", opts)
	if err != nil {
		p.mu.Lock()
		delete(p.entries, key)
		p.mu.Unlock()
		return nil, fmt.Errorf("connpool: create driver: %w", err)
	}

	if err := driver.Connect(ctx); err != nil {
		p.mu.Lock()
		delete(p.entries, key)
		p.mu.Unlock()
		return nil, fmt.Errorf("connpool: ssh connect: %w", err)
	}

	entry.Driver = driver

	// Extract CommandExecutor
	if exec, ok := driver.(protocol.CommandExecutor); ok {
		entry.Exec = exec
	}

	// Open SFTP subsystem on the same SSH connection
	if sshClient := getSSHClient(driver); sshClient != nil {
		sftpClient, err := sftp.NewClient(sshClient)
		if err != nil {
			slog.Warn("connpool: sftp subsystem failed, file operations disabled", "error", err)
		} else {
			entry.Backend = fileutil.NewSftpBackend(sftpClient)
		}
	}

	entry.mu.Lock()
	if needSSH {
		entry.sshRef = 1
	}
	if needSFTP {
		entry.sftpRef = 1
	}
	entry.mu.Unlock()

	slog.Info("connpool: new connection", "key", key)
	return entry, nil
}

// AcquireSSHRef increments the CommandExecutor reference count. Use this when
// a consumer needs exec capability on an existing pooled connection (e.g.
// cross-session transfer that was created with AcquireSFTP only).
func (e *Entry) AcquireSSHRef() {
	e.mu.Lock()
	e.sshRef++
	e.mu.Unlock()
}

// ReleaseSSH decrements the CommandExecutor reference count. If both counts
// reach zero, the connection is closed and removed from the pool.
func (e *Entry) ReleaseSSH() {
	e.mu.Lock()
	if e.sshRef > 0 {
		e.sshRef--
	}
	shouldClose := e.sshRef <= 0 && e.sftpRef <= 0
	e.mu.Unlock()

	if shouldClose {
		e.closeAndRemove()
	}
}

// ReleaseSFTP decrements the FileBackend reference count. If both counts
// reach zero, the connection is closed and removed from the pool.
func (e *Entry) ReleaseSFTP() {
	e.mu.Lock()
	if e.sftpRef > 0 {
		e.sftpRef--
	}
	shouldClose := e.sshRef <= 0 && e.sftpRef <= 0
	e.mu.Unlock()

	if shouldClose {
		e.closeAndRemove()
	}
}

// closeAndRemove closes the connection and removes the entry from the pool.
func (e *Entry) closeAndRemove() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.Backend != nil {
		e.Backend.Close()
		e.Backend = nil
	}
	if e.Driver != nil {
		e.Driver.Close()
		e.Driver = nil
	}
	e.Exec = nil

	e.pool.mu.Lock()
	delete(e.pool.entries, e.key)
	e.pool.mu.Unlock()

	slog.Info("connpool: connection closed", "key", e.key)
}

// getSSHClient extracts the underlying *ssh.Client from a driver via type
// assertion. Returns nil if the driver doesn't expose SSHClient().
func getSSHClient(driver protocol.Driver) *gossh.Client {
	type sshClientProvider interface {
		SSHClient() *gossh.Client
	}
	if provider, ok := driver.(sshClientProvider); ok {
		return provider.SSHClient()
	}
	return nil
}
