package proxypool

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// handshakeTimeout 兜住「连代理 + CONNECT/SOCKS5 握手」这两步，
// 避免某个坏代理把请求挂死。
const handshakeTimeout = 15 * time.Second

// Dial 经该出口建立到 addr（host:port）的隧道，返回一条裸连接。
// 上层（zen）会在这条连接上再做 Bun uTLS 握手，所以这里只负责隧道。
func (e *Entry) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if e == nil {
		return nil, errors.New("nil proxy entry")
	}
	dialer := &net.Dialer{Timeout: handshakeTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(e.Host, e.Port))
	if err != nil {
		return nil, fmt.Errorf("dial proxy %s: %w", e.Host, err)
	}

	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))

	switch e.Scheme {
	case "http":
		conn, err = httpConnect(conn, e.URL(), addr)
	case "https":
		tlsConn := tls.Client(conn, &tls.Config{ServerName: e.Host, MinVersion: tls.VersionTLS12})
		if err = tlsConn.HandshakeContext(ctx); err == nil {
			conn = tlsConn
			conn, err = httpConnect(conn, e.URL(), addr)
		}
	case "socks5", "socks5h":
		err = socks5Connect(conn, e.URL(), addr)
	default:
		err = fmt.Errorf("unsupported proxy scheme %q", e.Scheme)
	}
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if !stop() && ctx.Err() != nil {
		_ = conn.Close()
		return nil, ctx.Err()
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// httpConnect 向 HTTP 代理发 CONNECT，建立到 addr 的隧道。
func httpConnect(conn net.Conn, proxy *url.URL, addr string) (net.Conn, error) {
	request := "CONNECT " + addr + " HTTP/1.1\r\nHost: " + addr + "\r\n"
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		credential := base64.StdEncoding.EncodeToString([]byte(proxy.User.Username() + ":" + password))
		request += "Proxy-Authorization: Basic " + credential + "\r\n"
	}
	if _, err := io.WriteString(conn, request+"\r\n"); err != nil {
		return conn, err
	}
	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		return conn, err
	}
	status, err := parseConnectStatus(statusLine)
	if err != nil {
		return conn, err
	}
	// 吃掉剩余响应头，直到空行。
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return conn, err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	if status/100 != 2 {
		return conn, fmt.Errorf("proxy refused CONNECT: %s", strings.TrimSpace(statusLine))
	}
	if reader.Buffered() > 0 {
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

func parseConnectStatus(line string) (int, error) {
	// "HTTP/1.1 200 Connection established"
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0, fmt.Errorf("invalid CONNECT response: %q", strings.TrimSpace(line))
	}
	status, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("invalid CONNECT status: %q", strings.TrimSpace(line))
	}
	return status, nil
}

// bufferedConn 优先读走 bufio 里已经缓冲的字节（CONNECT 应答后面可能跟了数据）。
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

var socksReplies = map[byte]string{
	1: "general SOCKS server failure",
	2: "connection not allowed by ruleset",
	3: "network unreachable",
	4: "host unreachable",
	5: "connection refused",
	6: "TTL expired",
	7: "command not supported",
	8: "address type not supported",
}

// socks5Connect 走 RFC1928 CONNECT，附带 RFC1929 用户名/密码认证。
// 域名一律交给代理远端解析（等价 socks5h），出口地理更准。
func socks5Connect(conn net.Conn, proxy *url.URL, addr string) error {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return fmt.Errorf("invalid port %q", portText)
	}

	methods := []byte{0x00}
	if proxy.User != nil {
		methods = append(methods, 0x02)
	}
	if _, err := conn.Write(append([]byte{5, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 5 {
		return fmt.Errorf("unexpected SOCKS version %d", reply[0])
	}
	switch {
	case reply[1] == 0x00:
	case reply[1] == 0x02 && proxy.User != nil:
		password, _ := proxy.User.Password()
		name := proxy.User.Username()
		if len(name) == 0 || len(name) > 255 || len(password) > 255 {
			return errors.New("invalid SOCKS username/password")
		}
		auth := append([]byte{1, byte(len(name))}, name...)
		auth = append(append(auth, byte(len(password))), password...)
		if _, err := conn.Write(auth); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, reply); err != nil {
			return err
		}
		if reply[1] != 0 {
			return errors.New("SOCKS username/password authentication failed")
		}
	default:
		return errors.New("no acceptable SOCKS authentication method")
	}

	request := []byte{5, 1, 0}
	if ip := net.ParseIP(host); ip == nil {
		if len(host) > 255 {
			return errors.New("SOCKS target host too long")
		}
		request = append(append(request, 3, byte(len(host))), host...)
	} else if ip4 := ip.To4(); ip4 != nil {
		request = append(append(request, 1), ip4...)
	} else {
		request = append(append(request, 4), ip.To16()...)
	}
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		return err
	}

	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return err
	}
	if header[0] != 5 {
		return fmt.Errorf("unexpected SOCKS version %d", header[0])
	}
	if header[1] != 0 {
		if text, ok := socksReplies[header[1]]; ok {
			return errors.New(text)
		}
		return fmt.Errorf("unknown SOCKS reply %d", header[1])
	}
	var skip int
	switch header[3] {
	case 1:
		skip = net.IPv4len
	case 4:
		skip = net.IPv6len
	case 3:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			return err
		}
		skip = int(length[0])
	default:
		return fmt.Errorf("unknown SOCKS address type %d", header[3])
	}
	_, err = io.ReadFull(conn, make([]byte, skip+2))
	return err
}
