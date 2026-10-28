//go:build nomihomo

// 无内核构建（Vercel 用）：不引入 mihomo，只支持纯文本/URI/base64 里的
// http/socks5 代理，Clash YAML 里的 ss/vmess/vless/trojan/hysteria2 无法使用。
package proxypool

// KernelAvailable 表示当前构建是否带 mihomo 内核（Vercel 的 nomihomo 构建为 false）。
func KernelAvailable() bool { return false }

// parseClash 在无内核构建里恒为 false，ParseSubscription 会退回轻量解析。
func parseClash(_ []byte) (nodes []Dialer, skipped int, ok bool) {
	return nil, 0, false
}
