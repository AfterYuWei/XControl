package ssh

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/protocol"
)

func init() {
	// Registration is done in main.go via protocolManager.Register("ssh", NewDriver)
}

// keepaliveInterval is the interval between keepalive requests.
// keepaliveMaxFailures is the consecutive failure count that marks the connection dead.
// keepaliveRequestTimeout is the max wait for a single keepalive reply.
const (
	keepaliveInterval        = 30 * time.Second
	keepaliveMaxFailures     = 3
	keepaliveRequestTimeout  = 10 * time.Second
)

type Driver struct {
	opts   protocol.DriverOpts
	client *gossh.Client
	info   protocol.ConnectionInfo

	// Lifecycle management: keepalive probing + connection death detection
	doneCh     chan struct{}    // closed on Close() to signal goroutines to exit
	closeOnce  sync.Once        // guards doneCh from being closed twice
	dead       atomic.Bool      // set when the connection is detected dead
	deadReason string           // reason code (remote_shutdown | keepalive_timeout | ...)
	deadCbs    []func(reason string)
	cbMu       sync.Mutex       // protects deadCbs and deadReason
}

func NewDriver(opts protocol.DriverOpts) (protocol.Driver, error) {
	return &Driver{opts: opts, doneCh: make(chan struct{})}, nil
}

func (d *Driver) Connect(ctx context.Context) error {
	client, err := Dial(ctx, d.opts)
	if err != nil {
		return err
	}

	d.client = client
	d.info = protocol.ConnectionInfo{
		Protocol:   "ssh",
		Host:       d.opts.Host,
		Port:       d.opts.Port,
		Username:   d.opts.Username,
		RemoteAddr: client.RemoteAddr().String(),
	}

	// Start keepalive probing and connection-close watch goroutines.
	// These run for the lifetime of the connection and exit via doneCh on Close().
	go d.startKeepalive()
	go d.startWatch()

	return nil
}

// startKeepalive sends keepalive@openssh.com requests every keepaliveInterval.
// After keepaliveMaxFailures consecutive failures, the driver is marked dead.
func (d *Driver) startKeepalive() {
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-d.doneCh:
			return
		case <-ticker.C:
			if d.probeKeepalive() {
				failures = 0
				continue
			}
			failures++
			slog.Warn("ssh keepalive failed", "host", d.opts.Host, "failures", failures)
			if failures >= keepaliveMaxFailures {
				d.markDead("keepalive_timeout")
				return
			}
		}
	}
}

// probeKeepalive sends a single keepalive request with a timeout. Returns true on success.
func (d *Driver) probeKeepalive() bool {
	done := make(chan error, 1)
	go func() {
		_, _, err := d.client.SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	select {
	case <-d.doneCh:
		return true // closing, treat as success to avoid spurious dead marking
	case err := <-done:
		return err == nil
	case <-time.After(keepaliveRequestTimeout):
		slog.Warn("ssh keepalive request timed out", "host", d.opts.Host, "timeout", keepaliveRequestTimeout)
		return false
	}
}

// startWatch blocks on client.Wait() to detect connection closure initiated by
// the remote side or network. When the connection closes unexpectedly (i.e. not
// via our own Close()), the driver is marked dead with "remote_shutdown".
func (d *Driver) startWatch() {
	waitCh := make(chan struct{})
	go func() {
		_ = d.client.Wait()
		close(waitCh)
	}()
	select {
	case <-d.doneCh:
		return // graceful close initiated by us
	case <-waitCh:
		d.markDead("remote_shutdown")
	}
}

// markDead marks the driver as dead and invokes all registered OnDead callbacks
// exactly once. Safe to call from multiple goroutines.
func (d *Driver) markDead(reason string) {
	if !d.dead.CompareAndSwap(false, true) {
		return
	}
	d.cbMu.Lock()
	d.deadReason = reason
	cbs := make([]func(string), len(d.deadCbs))
	copy(cbs, d.deadCbs)
	d.deadCbs = nil
	d.cbMu.Unlock()

	slog.Warn("ssh connection marked dead", "host", d.opts.Host, "reason", reason)
	for _, cb := range cbs {
		cb(reason)
	}
}

// IsDead reports whether the connection has been detected as dead.
func (d *Driver) IsDead() bool {
	return d.dead.Load()
}

// DeadReason returns the reason code if dead, empty string otherwise.
func (d *Driver) DeadReason() string {
	d.cbMu.Lock()
	defer d.cbMu.Unlock()
	return d.deadReason
}

// OnDead registers a callback invoked when the connection dies. If the driver
// is already dead, the callback is invoked immediately. Multiple callbacks are
// supported and invoked in registration order.
func (d *Driver) OnDead(cb func(reason string)) {
	d.cbMu.Lock()
	defer d.cbMu.Unlock()
	if d.dead.Load() {
		cb(d.deadReason)
		return
	}
	d.deadCbs = append(d.deadCbs, cb)
}

func (d *Driver) RequestShell(opts protocol.ShellOptions) (protocol.Shell, error) {
	if d.client == nil {
		return nil, fmt.Errorf("not connected")
	}

	session, err := d.client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("new session: %w", err)
	}

	term := opts.Term
	if term == "" {
		term = "xterm-256color"
	}

	// IUTF8 (42) tells the remote kernel's line discipline that the terminal
	// uses UTF-8 encoding, ensuring correct cursor movement and line wrapping
	// for multi-byte characters.
	const IUTF8 uint8 = 42

	modes := gossh.TerminalModes{
		gossh.ECHO:          1,
		IUTF8:               1,
		gossh.TTY_OP_ISPEED: 115200,
		gossh.TTY_OP_OSPEED: 115200,
	}

	if err := session.RequestPty(term, opts.Rows, opts.Cols, modes); err != nil {
		session.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}

	// Request UTF-8 locale — server must have "AcceptEnv LANG" in sshd_config
	session.Setenv("LANG", "en_US.UTF-8")

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := session.Shell(); err != nil {
		session.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	// Enable Bracketed Paste Mode (DECSET 2004). This tells the remote shell
	// to distinguish pasted text from typed input. When the user pastes multi-line
	// text, xterm.js wraps it with \x1b[200~ ... \x1b[201~, and the shell treats
	// it as a single paste event instead of executing each line as a command.
	// This prevents accidental command execution when pasting scripts or logs.
	// The sequence is harmless on shells that don't support it (they ignore it).
	if _, err := stdin.Write([]byte("\x1b[?2004h")); err != nil {
		slog.Warn("failed to enable bracketed paste mode", "host", d.opts.Host, "err", err)
		// Continue anyway; bracketed paste is a quality-of-life feature, not critical.
	}

	return &Shell{
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		done:    make(chan struct{}),
	}, nil
}

func (d *Driver) Close() error {
	// Signal keepalive and watch goroutines to exit before closing the client.
	// This prevents the watch goroutine from treating our own Close() as a
	// "remote_shutdown" death event.
	d.closeOnce.Do(func() {
		close(d.doneCh)
	})
	if d.client != nil {
		return d.client.Close()
	}
	return nil
}

func (d *Driver) Info() protocol.ConnectionInfo {
	return d.info
}

// Exec runs a command on the remote host via a temporary SSH session.
// Implements protocol.CommandExecutor.
func (d *Driver) Exec(cmd string) (stdout []byte, stderr []byte, exitCode int, err error) {
	return d.ExecContext(context.Background(), cmd)
}

// ExecContext runs a command on the remote host via a temporary SSH session
// and stops the session when the caller's context is canceled or times out.
func (d *Driver) ExecContext(ctx context.Context, cmd string) (stdout []byte, stderr []byte, exitCode int, err error) {
	if d.client == nil {
		return nil, nil, -1, fmt.Errorf("not connected")
	}
	sess, err := d.client.NewSession()
	if err != nil {
		return nil, nil, -1, fmt.Errorf("new session: %w", err)
	}
	defer sess.Close()

	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	sess.Stdout = &stdoutBuf
	sess.Stderr = &stderrBuf

	if err := sess.Start(cmd); err != nil {
		return nil, nil, -1, err
	}

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- sess.Wait()
	}()

	select {
	case err := <-waitCh:
		stdout = stdoutBuf.Bytes()
		stderr = stderrBuf.Bytes()
		if err != nil {
			if exitErr, ok := err.(*gossh.ExitError); ok {
				return stdout, stderr, exitErr.ExitStatus(), err
			}
			return stdout, stderr, -1, err
		}
		return stdout, stderr, 0, nil
	case <-ctx.Done():
		_ = sess.Close()
		return stdoutBuf.Bytes(), stderrBuf.Bytes(), -1, ctx.Err()
	}
}

// SSHClient returns the underlying SSH client for opening subsystem channels
// (e.g. SFTP). Used by the connection pool to share one SSH connection for
// both command execution and file operations.
func (d *Driver) SSHClient() *gossh.Client {
	return d.client
}

// compile-time assertion that Driver implements CommandExecutor
var _ protocol.CommandExecutor = (*Driver)(nil)
var _ protocol.ContextCommandExecutor = (*Driver)(nil)

// compile-time assertion that Driver implements ConnectionLifecycle
var _ protocol.ConnectionLifecycle = (*Driver)(nil)
