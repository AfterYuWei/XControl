package protocol

import "context"

// Driver is the unified interface for all remote connection protocols.
type Driver interface {
	Connect(ctx context.Context) error
	RequestShell(opts ShellOptions) (Shell, error)
	Close() error
	Info() ConnectionInfo
}

// Shell is an interactive terminal session.
type Shell interface {
	Write(data []byte) (int, error)
	Read(buf []byte) (int, error)
	Resize(cols, rows int) error
	Close() error
	Done() <-chan struct{}
	ExitCode() int
}

type ShellOptions struct {
	Cols int
	Rows int
	Term string // default "xterm-256color"
}

type ConnectionInfo struct {
	Protocol   string // "ssh" | "sftp" | "serial"
	Host       string
	Port       int
	Username   string
	RemoteAddr string
}
