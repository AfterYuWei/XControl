package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/protocol"
)

// InspectHostKeyFingerprint captures the current host key fingerprint without
// completing authentication.
func InspectHostKeyFingerprint(ctx context.Context, opts protocol.DriverOpts) (string, error) {
	addr := net.JoinHostPort(opts.Host, fmt.Sprintf("%d", opts.Port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}

	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return "", err
	}
	defer conn.Close()

	var fingerprint string
	config := &gossh.ClientConfig{
		User: opts.Username,
		HostKeyCallback: func(_ string, _ net.Addr, key gossh.PublicKey) error {
			fingerprint = gossh.FingerprintSHA256(key)
			return errHostKeyCaptured
		},
		Timeout: 10 * time.Second,
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

var errHostKeyCaptured = fmt.Errorf("host key captured")
