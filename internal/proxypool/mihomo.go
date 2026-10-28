//go:build !nomihomo

// 带内核构建：Clash 订阅的 ss/vmess/vless/trojan/hysteria2 等由 mihomo 解析。
// Vercel 用 -tags nomihomo 排除本文件，二进制从 ~46MB 降到 ~8MB。
package proxypool

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"

	mh "github.com/metacubex/mihomo/adapter"
	C "github.com/metacubex/mihomo/constant"
	"gopkg.in/yaml.v3"
)

// mihomoNode 把一个 Clash 节点包成 Dialer：ss / vmess / vless / trojan /
// hysteria2 / http / socks5 等都由 mihomo 内核负责，我们只负责取节点、拨号。
type mihomoNode struct {
	name  string
	kind  string
	proxy C.Proxy
}

func (n *mihomoNode) Label() string {
	if n.name == "" {
		return n.kind
	}
	return n.kind + ":" + n.name
}

func (n *mihomoNode) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("mihomo node %s only supports tcp, got %q", n.Label(), network)
	}
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("invalid port %q", portText)
	}
	metadata := &C.Metadata{NetWork: C.TCP, Type: C.SOCKS5, DstPort: uint16(port)}
	if ip, err := netip.ParseAddr(host); err == nil {
		metadata.DstIP = ip
	} else {
		metadata.Host = host
	}
	conn, err := n.proxy.DialContext(ctx, metadata)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// ParseSubscription 已移到 subscription.go（根据构建标签选择是否带内核）。
func parseClash(body []byte) (nodes []Dialer, skipped int, ok bool) {
	var doc struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(body, &doc); err != nil || len(doc.Proxies) == 0 {
		return nil, 0, false
	}
	for _, raw := range doc.Proxies {
		// 带 dialer-proxy 的节点需要经另一个节点链式中转，单节点池无法安全复现，跳过。
		if _, chained := raw["dialer-proxy"]; chained {
			skipped++
			continue
		}
		proxy, err := mh.ParseProxy(raw)
		if err != nil {
			skipped++
			continue
		}
		name, _ := raw["name"].(string)
		kind, _ := raw["type"].(string)
		nodes = append(nodes, &mihomoNode{name: name, kind: kind, proxy: proxy})
	}
	return nodes, skipped, true
}
