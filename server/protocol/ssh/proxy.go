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
	"strings"
	"time"

	"github.com/yuweinfo/xcontrol/protocol"
)

func dialTransport(ctx context.Context, addr string, proxyOpts *protocol.ProxyOpts) (net.Conn, error) {
	dialCtx, cancel := withConnectTimeout(ctx)
	defer cancel()
	if proxyOpts == nil {
		return (&net.Dialer{}).DialContext(dialCtx, "tcp", addr)
	}
	proxyAddr := net.JoinHostPort(proxyOpts.Host, strconv.Itoa(proxyOpts.Port))
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("连接代理 %s: %w", proxyAddr, err)
	}
	if deadline, ok := dialCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	tunneled := conn
	switch proxyOpts.Type {
	case "socks5":
		err = establishSOCKS5(conn, addr, proxyOpts.Username, proxyOpts.Password)
	case "http":
		tunneled, err = establishHTTPConnect(conn, addr, proxyOpts.Username, proxyOpts.Password)
	default:
		err = fmt.Errorf("不支持的代理类型: %s", proxyOpts.Type)
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return tunneled, nil
}

func establishSOCKS5(conn net.Conn, targetAddr, username, password string) error {
	methods := []byte{0x00}
	if username != "" {
		methods = append(methods, 0x02)
	}
	greeting := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(greeting); err != nil {
		return fmt.Errorf("SOCKS5 协商失败: %w", err)
	}
	response := make([]byte, 2)
	if _, err := io.ReadFull(conn, response); err != nil {
		return fmt.Errorf("读取 SOCKS5 协商响应: %w", err)
	}
	if response[0] != 0x05 || response[1] == 0xff {
		return fmt.Errorf("SOCKS5 代理不接受可用的认证方式")
	}
	if response[1] == 0x02 {
		if username == "" || len(username) > 255 || len(password) > 255 {
			return fmt.Errorf("SOCKS5 代理认证参数无效")
		}
		auth := []byte{0x01, byte(len(username))}
		auth = append(auth, username...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, password...)
		if _, err := conn.Write(auth); err != nil {
			return fmt.Errorf("SOCKS5 认证失败: %w", err)
		}
		if _, err := io.ReadFull(conn, response); err != nil || response[1] != 0x00 {
			return fmt.Errorf("SOCKS5 用户名或密码错误")
		}
	} else if response[1] != 0x00 {
		return fmt.Errorf("SOCKS5 代理返回未知认证方式: %d", response[1])
	}

	host, portText, err := net.SplitHostPort(targetAddr)
	if err != nil {
		return fmt.Errorf("解析目标地址: %w", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("目标端口无效")
	}
	request := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			request = append(request, 0x01)
			request = append(request, v4...)
		} else {
			request = append(request, 0x04)
			request = append(request, ip.To16()...)
		}
	} else {
		if len(host) == 0 || len(host) > 255 {
			return fmt.Errorf("SOCKS5 目标域名长度无效")
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, host...)
	}
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		return fmt.Errorf("发送 SOCKS5 CONNECT: %w", err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return fmt.Errorf("读取 SOCKS5 CONNECT 响应: %w", err)
	}
	if header[0] != 0x05 || header[1] != 0x00 {
		return fmt.Errorf("SOCKS5 CONNECT 被拒绝，状态码 %d", header[1])
	}
	var skip int
	switch header[3] {
	case 0x01:
		skip = 4
	case 0x04:
		skip = 16
	case 0x03:
		length := []byte{0}
		if _, err := io.ReadFull(conn, length); err != nil {
			return err
		}
		skip = int(length[0])
	default:
		return fmt.Errorf("SOCKS5 返回未知地址类型")
	}
	_, err = io.CopyN(io.Discard, conn, int64(skip+2))
	return err
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func establishHTTPConnect(conn net.Conn, targetAddr, username, password string) (net.Conn, error) {
	var builder strings.Builder
	fmt.Fprintf(&builder, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", targetAddr, targetAddr)
	if username != "" {
		token := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
		fmt.Fprintf(&builder, "Proxy-Authorization: Basic %s\r\n", token)
	}
	builder.WriteString("Proxy-Connection: Keep-Alive\r\n\r\n")
	if _, err := io.WriteString(conn, builder.String()); err != nil {
		return nil, fmt.Errorf("发送 HTTP CONNECT: %w", err)
	}
	request := &http.Request{Method: http.MethodConnect}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return nil, fmt.Errorf("读取 HTTP CONNECT 响应: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.Body != nil {
			response.Body.Close()
		}
		return nil, fmt.Errorf("HTTP CONNECT 被拒绝: %s", response.Status)
	}
	return &bufferedConn{Conn: conn, reader: reader}, nil
}
