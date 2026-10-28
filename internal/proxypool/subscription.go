package proxypool

// ParseSubscription 把订阅正文变成出口列表：
//  1. 带内核构建时先按 Clash YAML（proxies:）交给 mihomo 解析，支持
//     ss/vmess/vless/trojan/hysteria2/http/socks5 等；
//  2. 不带内核（-tags nomihomo）或不是 Clash 配置时，退回纯文本/URI/base64/
//     sing-box 解析（只支持 http/socks）。
func ParseSubscription(body []byte) ([]Dialer, int) {
	if nodes, skipped, ok := parseClash(body); ok && len(nodes) > 0 {
		return nodes, skipped
	}
	entries, skipped := ParseContent(string(body))
	dialers := make([]Dialer, 0, len(entries))
	for i := range entries {
		dialers = append(dialers, &entries[i])
	}
	return dialers, skipped
}
