package proxypool

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestEntryDialHTTPConnect(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()

	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer func() { _ = conn.Close() }()
		br := bufio.NewReader(conn)
		line, err := br.ReadString('\n')
		if err != nil {
			done <- err
			return
		}
		if !strings.HasPrefix(line, "CONNECT example.com:443 ") {
			done <- fmt.Errorf("unexpected CONNECT line %q", line)
			return
		}
		for {
			header, err := br.ReadString('\n')
			if err != nil {
				done <- err
				return
			}
			if header == "\r\n" || header == "\n" {
				break
			}
		}
		if _, err := conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
			done <- err
			return
		}
		buf := make([]byte, 4)
		if _, err := io.ReadFull(br, buf); err != nil {
			done <- err
			return
		}
		_, err = conn.Write(buf)
		done <- err
	}()

	host, port, _ := net.SplitHostPort(ln.Addr().String())
	entry := &Entry{Scheme: "http", Host: host, Port: port}
	conn, err := entry.Dial(context.Background(), "tcp", "example.com:443")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, 4)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != "ping" {
		t.Fatalf("echo = %q, want ping", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("server: %v", err)
	}
}

func TestEntryDialSOCKS5(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()

	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer func() { _ = conn.Close() }()
		br := bufio.NewReader(conn)

		greeting := make([]byte, 2)
		if _, err := io.ReadFull(br, greeting); err != nil {
			done <- err
			return
		}
		methods := make([]byte, greeting[1])
		if _, err := io.ReadFull(br, methods); err != nil {
			done <- err
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			done <- err
			return
		}

		head := make([]byte, 4)
		if _, err := io.ReadFull(br, head); err != nil {
			done <- err
			return
		}
		var skip int
		switch head[3] {
		case 1:
			skip = 4
		case 4:
			skip = 16
		case 3:
			length := make([]byte, 1)
			if _, err := io.ReadFull(br, length); err != nil {
				done <- err
				return
			}
			skip = int(length[0])
		}
		if _, err := io.ReadFull(br, make([]byte, skip+2)); err != nil {
			done <- err
			return
		}
		if _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			done <- err
			return
		}
		buf := make([]byte, 4)
		if _, err := io.ReadFull(br, buf); err != nil {
			done <- err
			return
		}
		_, err = conn.Write(buf)
		done <- err
	}()

	host, port, _ := net.SplitHostPort(ln.Addr().String())
	entry := &Entry{Scheme: "socks5", Host: host, Port: port}
	conn, err := entry.Dial(context.Background(), "tcp", "example.com:443")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte("pong")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, 4)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != "pong" {
		t.Fatalf("echo = %q, want pong", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("server: %v", err)
	}
}
