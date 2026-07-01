package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/yuweinfo/xcontrol/protocol"
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

		// If an SSH certificate is provided, wrap the signer so the client
		// presents the certificate for authentication. The certificate's
		// public key must match the private key's public key.
		if opts.Cert != "" {
			certSigner, certErr := buildCertSigner(opts.Cert, signer)
			if certErr != nil {
				return nil, fmt.Errorf("build cert signer: %w", certErr)
			}
			signer = certSigner
		}
		config.Auth = append(config.Auth, gossh.PublicKeys(signer))
	}

	return config, nil
}

// buildCertSigner parses an OpenSSH certificate (authorized-keys format) and
// combines it with the private key signer to produce a certificate-backed
// signer usable with gossh.PublicKeys.
func buildCertSigner(certPEM string, priv gossh.Signer) (gossh.Signer, error) {
	pubKey, _, _, _, err := gossh.ParseAuthorizedKey([]byte(certPEM))
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	cert, ok := pubKey.(*gossh.Certificate)
	if !ok {
		return nil, fmt.Errorf("provided key is not an SSH certificate")
	}
	return gossh.NewCertSigner(cert, priv)
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
