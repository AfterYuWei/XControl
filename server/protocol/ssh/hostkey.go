package ssh

import (
	"context"
	"fmt"
	"net"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/protocol"
)

// InspectHostKeyFingerprint captures the current host key fingerprint without
// completing authentication.
func InspectHostKeyFingerprint(ctx context.Context, opts protocol.DriverOpts) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	var cancel context.CancelFunc
	if _, ok := ctx.Deadline(); !ok {
		ctx, cancel = context.WithTimeout(ctx, DefaultConnectTimeout)
		defer cancel()
	}

	addr := net.JoinHostPort(opts.Host, fmt.Sprintf("%d", opts.Port))
	conn, upstream, err := dialForInspection(ctx, opts, addr)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if upstream != nil {
		defer upstream.Close()
	}

	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return "", err
		}
	}

	var fingerprint string
	config := &gossh.ClientConfig{
		User: opts.Username,
		HostKeyCallback: func(_ string, _ net.Addr, key gossh.PublicKey) error {
			fingerprint = gossh.FingerprintSHA256(key)
			return errHostKeyCaptured
		},
		Timeout: DefaultConnectTimeout,
	}

	_, _, _, err = gossh.NewClientConn(conn, addr, config)
	if fingerprint != "" {
		return fingerprint, nil
	}
	if err != nil {
		return "", err
	}
	return "", fmt.Errorf("host key fingerprint not received")
}

func dialForInspection(ctx context.Context, opts protocol.DriverOpts, addr string) (net.Conn, *Client, error) {
	if opts.JumpHost != nil {
		jumpClient, err := Dial(ctx, *opts.JumpHost)
		if err != nil {
			return nil, nil, fmt.Errorf("连接跳板机: %w", err)
		}
		conn, err := jumpClient.Dial("tcp", addr)
		if err != nil {
			jumpClient.Close()
			return nil, nil, fmt.Errorf("通过跳板机连接目标: %w", err)
		}
		return conn, jumpClient, nil
	}
	conn, err := dialTransport(ctx, addr, opts.Proxy)
	return conn, nil, err
}

var errHostKeyCaptured = fmt.Errorf("host key captured")
