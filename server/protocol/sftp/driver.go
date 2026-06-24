// Package sftp implements the SFTP protocol driver. It establishes an SSH
// connection and opens an SFTP subsystem channel on top of it. The driver
// implements protocol.Driver (for connection lifecycle) and fileutil.
// BackendProvider (for file operations), following the optional-interface
// pattern — protocol.Driver stays focused on terminal sessions, and file
// operations are exposed only when the driver implements BackendProvider.
package sftp

import (
	"context"
	"fmt"
	"net"

	gossh "golang.org/x/crypto/ssh"
	"github.com/pkg/sftp"

	"github.com/yuweinfo/sshx/fileutil"
	sshdriver "github.com/yuweinfo/sshx/protocol/ssh"
	"github.com/yuweinfo/sshx/protocol"
)

type Driver struct {
	opts   protocol.DriverOpts
	client *gossh.Client
	sftp   *sftp.Client
	backend fileutil.FileBackend
	info   protocol.ConnectionInfo
}

func NewDriver(opts protocol.DriverOpts) (protocol.Driver, error) {
	return &Driver{opts: opts}, nil
}

func (d *Driver) Connect(ctx context.Context) error {
	// Reuse the shared SSH dial logic from protocol/ssh
	client, err := sshdriver.Dial(ctx, d.opts)
	if err != nil {
		return err
	}
	d.client = client

	// Open SFTP subsystem
	sc, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return fmt.Errorf("new sftp client: %w", err)
	}
	d.sftp = sc
	d.backend = fileutil.NewSftpBackend(sc)

	d.info = protocol.ConnectionInfo{
		Protocol:   "sftp",
		Host:       d.opts.Host,
		Port:       d.opts.Port,
		Username:   d.opts.Username,
		RemoteAddr: client.RemoteAddr().String(),
	}
	return nil
}

// RequestShell is not supported by the SFTP driver. It exists only to satisfy
// the protocol.Driver interface.
func (d *Driver) RequestShell(opts protocol.ShellOptions) (protocol.Shell, error) {
	return nil, fmt.Errorf("sftp driver does not support shell sessions")
}

func (d *Driver) Close() error {
	var errs []error
	if d.backend != nil {
		if err := d.backend.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if d.client != nil {
		if err := d.client.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errs[0]
	}
	return nil
}

func (d *Driver) Info() protocol.ConnectionInfo {
	return d.info
}

// FileBackend implements fileutil.BackendProvider, exposing the SFTP file
// operations to handlers that check for this optional interface.
func (d *Driver) FileBackend() fileutil.FileBackend {
	return d.backend
}

// SftpClient returns the underlying sftp.Client for advanced use.
func (d *Driver) SftpClient() *sftp.Client {
	return d.sftp
}

// SSHClient returns the underlying SSH client (e.g. for port forwarding).
func (d *Driver) SSHClient() *gossh.Client {
	return d.client
}

// compile-time assertion that Driver implements both interfaces
var _ protocol.Driver = (*Driver)(nil)
var _ fileutil.BackendProvider = (*Driver)(nil)

// Ensure net is used (for future address helpers)
var _ = net.JoinHostPort
