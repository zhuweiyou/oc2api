package proxypool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
)

// Dialer 是一个可轮换的出口：能拨号，有展示标签，也有跨刷新稳定的 Key。
type Dialer interface {
	Dial(ctx context.Context, network, addr string) (net.Conn, error)
	Label() string
	// Key 是节点的稳定标识：订阅刷新后同一个节点仍是同一个 Key，
	// 用来保留健康/冷却状态。不能包含会变的显示名。
	Key() string
}

// Label 实现 Dialer。
func (e Entry) Label() string { return e.HostPort() }

// Key 用「协议 + 地址 + 认证」做稳定标识；凭据变了就视为新节点。
func (e Entry) Key() string {
	return hashKey(e.Scheme + "|" + e.Host + "|" + e.Port + "|" + e.User + "|" + e.Pass)
}

func hashKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}
