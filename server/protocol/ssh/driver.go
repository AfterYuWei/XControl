package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

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
	config, err := buildSSHConfig(d.opts)
	if err != nil {
		return fmt.Errorf("build ssh config: %w", err)
	}

	addr := net.JoinHostPort(d.opts.Host, fmt.Sprintf("%d", d.opts.Port))

	var client *gossh.Client
	if d.opts.JumpHost != nil {
		client, err = connectViaJump(ctx, d.opts.JumpHost, addr, config)
	} else {
		client, err = gossh.Dial("tcp", addr, config)
	}
	if err != nil {
		return fmt.Errorf("ssh dial: %w", err)
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

func buildSSHConfig(opts protocol.DriverOpts) (*gossh.ClientConfig, error) {
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

func connectViaJump(ctx context.Context, jumpOpts *protocol.DriverOpts, targetAddr string, targetConfig *gossh.ClientConfig) (*gossh.Client, error) {
	jumpConfig, err := buildSSHConfig(*jumpOpts)
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
