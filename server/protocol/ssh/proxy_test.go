package ssh

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/yuweinfo/xcontrol/protocol"
)

func TestHTTPConnectProxyWithBasicAuth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			done <- err
			return
		}
		if req.Method != http.MethodConnect || req.Host != "internal.example:22" {
			done <- fmt.Errorf("unexpected CONNECT request: %s %s", req.Method, req.Host)
			return
		}
		wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:secret"))
		if got := req.Header.Get("Proxy-Authorization"); got != wantAuth {
			done <- fmt.Errorf("Proxy-Authorization = %q", got)
			return
		}
		if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			done <- err
			return
		}
		buffer := []byte{0}
		if _, err := io.ReadFull(conn, buffer); err == nil {
			_, err = conn.Write(buffer)
		}
		done <- err
	}()

	host, port, _ := net.SplitHostPort(listener.Addr().String())
	portNumber, _ := strconv.Atoi(port)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := dialTransport(ctx, "internal.example:22", &protocol.ProxyOpts{Type: "http", Host: host, Port: portNumber, Username: "alice", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{0x42}); err != nil {
		t.Fatal(err)
	}
	buffer := []byte{0}
	if _, err := io.ReadFull(conn, buffer); err != nil || buffer[0] != 0x42 {
		t.Fatalf("tunnel echo = %x, %v", buffer, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestSOCKS5ProxyUsesRemoteDNSAndAuth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		header := make([]byte, 2)
		if _, err = io.ReadFull(reader, header); err != nil {
			done <- err
			return
		}
		methods := make([]byte, int(header[1]))
		if _, err = io.ReadFull(reader, methods); err != nil {
			done <- err
			return
		}
		_, err = conn.Write([]byte{0x05, 0x02})
		if err != nil {
			done <- err
			return
		}
		if _, err = io.ReadFull(reader, header); err != nil {
			done <- err
			return
		}
		username := make([]byte, int(header[1]))
		if _, err = io.ReadFull(reader, username); err != nil {
			done <- err
			return
		}
		passwordLen, err := reader.ReadByte()
		if err != nil {
			done <- err
			return
		}
		password := make([]byte, int(passwordLen))
		if _, err = io.ReadFull(reader, password); err != nil {
			done <- err
			return
		}
		if string(username) != "alice" || string(password) != "secret" {
			done <- fmt.Errorf("bad credentials")
			return
		}
		if _, err = conn.Write([]byte{0x01, 0x00}); err != nil {
			done <- err
			return
		}
		request := make([]byte, 5)
		if _, err = io.ReadFull(reader, request); err != nil {
			done <- err
			return
		}
		if request[0] != 0x05 || request[1] != 0x01 || request[3] != 0x03 {
			done <- fmt.Errorf("request did not use domain address: %x", request)
			return
		}
		domain := make([]byte, int(request[4]))
		if _, err = io.ReadFull(reader, domain); err != nil {
			done <- err
			return
		}
		portBytes := make([]byte, 2)
		if _, err = io.ReadFull(reader, portBytes); err != nil {
			done <- err
			return
		}
		if string(domain) != "internal.example" || portBytes[0] != 0 || portBytes[1] != 22 {
			done <- fmt.Errorf("bad target %s:%x", domain, portBytes)
			return
		}
		if _, err = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22}); err != nil {
			done <- err
			return
		}
		value, err := reader.ReadByte()
		if err == nil {
			_, err = conn.Write([]byte{value})
		}
		done <- err
	}()

	host, port, _ := net.SplitHostPort(listener.Addr().String())
	portNumber, _ := strconv.Atoi(port)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := dialTransport(ctx, "internal.example:22", &protocol.ProxyOpts{Type: "socks5", Host: host, Port: portNumber, Username: "alice", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{0x33}); err != nil {
		t.Fatal(err)
	}
	buffer := []byte{0}
	if _, err := io.ReadFull(conn, buffer); err != nil || buffer[0] != 0x33 {
		t.Fatalf("tunnel echo = %x, %v", buffer, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHTTPConnectRejectsNon2xx(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = http.ReadRequest(bufio.NewReader(conn))
		_, _ = io.WriteString(conn, "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	portNumber, _ := strconv.Atoi(port)
	_, err = dialTransport(context.Background(), "internal.example:22", &protocol.ProxyOpts{Type: "http", Host: host, Port: portNumber})
	if err == nil {
		t.Fatal("expected non-2xx CONNECT to fail")
	}
}
