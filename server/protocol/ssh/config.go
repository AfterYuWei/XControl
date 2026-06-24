package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/sshx/protocol"
)

// BuildSSHConfig constructs a gossh.ClientConfig from DriverOpts. Exported so
// other protocol drivers (e.g. SFTP) can reuse the same authentication logic.
func BuildSSHConfig(opts protocol.DriverOpts) (*gossh.ClientConfig, error) {
	config := &gossh.ClientConfig{
		User:            opts.Username,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}

	if opts.Password != "" {
		config.Auth = append(config.Auth, gossh.Password(opts.Password))
	}

	if opts.PrivKey != "" {
		var signer gossh.Signer
		var err error
		if opts.Passphrase != "" {
			signer, err = gossh.ParsePrivateKeyWithPassphrase([]byte(opts.PrivKey), []byte(opts.Passphrase))
		} else {
			signer, err = gossh.ParsePrivateKey([]byte(opts.PrivKey))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		config.Auth = append(config.Auth, gossh.PublicKeys(signer))
	}

	return config, nil
}

// ConnectViaJump dials the target SSH server through a jump host. Exported for
// reuse by other protocol drivers that need ProxyJump support.
func ConnectViaJump(ctx context.Context, jumpOpts *protocol.DriverOpts, targetAddr string, targetConfig *gossh.ClientConfig) (*gossh.Client, error) {
	jumpConfig, err := BuildSSHConfig(*jumpOpts)
	if err != nil {
		return nil, fmt.Errorf("jump host config: %w", err)
	}

	jumpAddr := net.JoinHostPort(jumpOpts.Host, fmt.Sprintf("%d", jumpOpts.Port))
	jumpClient, err := gossh.Dial("tcp", jumpAddr, jumpConfig)
	if err != nil {
		return nil, fmt.Errorf("dial jump host: %w", err)
	}

	conn, err := jumpClient.Dial("tcp", targetAddr)
	if err != nil {
		jumpClient.Close()
		return nil, fmt.Errorf("dial target via jump: %w", err)
	}

	ncc, chans, reqs, err := gossh.NewClientConn(conn, targetAddr, targetConfig)
	if err != nil {
		jumpClient.Close()
		conn.Close()
		return nil, fmt.Errorf("ssh handshake with target: %w", err)
	}

	return gossh.NewClient(ncc, chans, reqs), nil
}

// Dial establishes an SSH connection, optionally through a jump host. This is
// a convenience wrapper combining BuildSSHConfig + direct/jump dial.
func Dial(ctx context.Context, opts protocol.DriverOpts) (*gossh.Client, error) {
	config, err := BuildSSHConfig(opts)
	if err != nil {
		return nil, fmt.Errorf("build ssh config: %w", err)
	}

	addr := net.JoinHostPort(opts.Host, fmt.Sprintf("%d", opts.Port))

	if opts.JumpHost != nil {
		return ConnectViaJump(ctx, opts.JumpHost, addr, config)
	}
	return gossh.Dial("tcp", addr, config)
}
