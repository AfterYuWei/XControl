package ssh

import (
	"context"
	"fmt"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/sshx/protocol"
)

func init() {
	// Registration is done in main.go via protocolManager.Register("ssh", NewDriver)
}

type Driver struct {
	opts   protocol.DriverOpts
	client *gossh.Client
	info   protocol.ConnectionInfo
}

func NewDriver(opts protocol.DriverOpts) (protocol.Driver, error) {
	return &Driver{opts: opts}, nil
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

	return nil
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

	modes := gossh.TerminalModes{
		gossh.ECHO:          1,
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

	return &Shell{
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		done:    make(chan struct{}),
	}, nil
}

func (d *Driver) Close() error {
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
	if d.client == nil {
		return nil, nil, -1, fmt.Errorf("not connected")
	}
	sess, err := d.client.NewSession()
	if err != nil {
		return nil, nil, -1, fmt.Errorf("new session: %w", err)
	}
	defer sess.Close()

stdout, err = sess.CombinedOutput(cmd)
	if err != nil {
		if exitErr, ok := err.(*gossh.ExitError); ok {
			return stdout, nil, exitErr.ExitStatus(), err
		}
		return stdout, nil, -1, err
	}
	return stdout, nil, 0, nil
}

// SSHClient returns the underlying SSH client for opening subsystem channels
// (e.g. SFTP). Used by the connection pool to share one SSH connection for
// both command execution and file operations.
func (d *Driver) SSHClient() *gossh.Client {
	return d.client
}

// compile-time assertion that Driver implements CommandExecutor
var _ protocol.CommandExecutor = (*Driver)(nil)
