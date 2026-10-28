package proxypool

import (
	"context"
	"net"
)

// Dialer 是一个可轮换的出口：能拨号，并有一个不含凭据的标签。
type Dialer interface {
	Dial(ctx context.Context, network, addr string) (net.Conn, error)
	Label() string
}

// Label 实现 Dialer。
func (e *Entry) Label() string { return e.HostPort() }
