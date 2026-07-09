package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/protocol"
)

const (
	// DefaultConnectTimeout covers TCP connect plus the initial SSH handshake
	// and authentication, which can be noticeably slower on high-latency links.
	DefaultConnectTimeout = 30 * time.Second
)

// BuildSSHConfig constructs a gossh.ClientConfig from DriverOpts. Exported so
// other protocol drivers (e.g. SFTP) can reuse the same authentication logic.
func BuildSSHConfig(opts protocol.DriverOpts) (*gossh.ClientConfig, error) {
	config := &gossh.ClientConfig{
		User:    opts.Username,
		Timeout: DefaultConnectTimeout,
	}
	config.HostKeyCallback = func(_ string, _ net.Addr, key gossh.PublicKey) error {
		if opts.HostKeyFingerprint == "" {
			return nil
		}
		actual := gossh.FingerprintSHA256(key)
		if actual != opts.HostKeyFingerprint {
			return fmt.Errorf("host key fingerprint mismatch: expected %s, got %s", opts.HostKeyFingerprint, actual)
		}
		return nil
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
	jumpClient, err := dialClient(ctx, jumpAddr, jumpConfig)
	if err != nil {
		return nil, fmt.Errorf("dial jump host: %w", err)
	}

	conn, err := jumpClient.Dial("tcp", targetAddr)
	if err != nil {
		jumpClient.Close()
		return nil, fmt.Errorf("dial target via jump: %w", err)
	}

	deadlineCtx, cancel := withConnectTimeout(ctx)
	defer cancel()

	if deadline, ok := deadlineCtx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			jumpClient.Close()
			conn.Close()
			return nil, err
		}
	}

	ncc, chans, reqs, err := gossh.NewClientConn(conn, targetAddr, targetConfig)
	if err != nil {
		jumpClient.Close()
		conn.Close()
		return nil, fmt.Errorf("ssh handshake with target: %w", err)
	}

	_ = conn.SetDeadline(time.Time{})

	return gossh.NewClient(ncc, chans, reqs), nil
}

func withConnectTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, DefaultConnectTimeout)
}

func dialClient(ctx context.Context, addr string, config *gossh.ClientConfig) (*gossh.Client, error) {
	dialCtx, cancel := withConnectTimeout(ctx)
	defer cancel()

	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(dialCtx, "tcp", addr)
	if err != nil {
		return nil, err
	}

	if deadline, ok := dialCtx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			conn.Close()
			return nil, err
		}
	}

	ncc, chans, reqs, err := gossh.NewClientConn(conn, addr, config)
	if err != nil {
		conn.Close()
		return nil, err
	}

	// Clear the handshake deadline so the established SSH connection can stay
	// open indefinitely after the initial connect/auth flow completes.
	_ = conn.SetDeadline(time.Time{})

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
	client, err := dialClient(ctx, addr, config)
	if err != nil {
		return nil, fmt.Errorf("dial target: %w", err)
	}
	return client, nil
}
