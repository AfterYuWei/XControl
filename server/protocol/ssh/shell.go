package ssh

import (
	"io"

	gossh "golang.org/x/crypto/ssh"
)

type Shell struct {
	session  *gossh.Session
	stdin    io.WriteCloser
	stdout   io.Reader
	done     chan struct{}
	exitCode int
}

func (s *Shell) Write(data []byte) (int, error) {
	return s.stdin.Write(data)
}

func (s *Shell) Read(buf []byte) (int, error) {
	return s.stdout.Read(buf)
}

func (s *Shell) Resize(cols, rows int) error {
	return s.session.WindowChange(rows, cols)
}

func (s *Shell) Close() error {
	err := s.session.Close()
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	return err
}

func (s *Shell) Done() <-chan struct{} {
	return s.done
}

func (s *Shell) ExitCode() int {
	return s.exitCode
}

// Wait should be called in a goroutine to detect session exit.
func (s *Shell) Wait() {
	err := s.session.Wait()
	if err != nil {
		if exitErr, ok := err.(*gossh.ExitError); ok {
			s.exitCode = exitErr.ExitStatus()
		} else {
			s.exitCode = -1
		}
	}
	select {
	case <-s.done:
	default:
		close(s.done)
	}
}
