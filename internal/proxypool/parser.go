package proxypool

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Entry 是一个可直接用于拨号的代理出口。
type Entry struct {
	Scheme string // http | https | socks5 | socks5h
	Host   string
	Port   string
	User   string
	Pass   string
}

// URL 还原成 net/url.URL，供拨号层使用。
func (e Entry) URL() *url.URL {
	u := &url.URL{Scheme: e.Scheme, Host: net.JoinHostPort(e.Host, e.Port)}
	if e.User != "" {
		if e.Pass != "" {
			u.User = url.UserPassword(e.User, e.Pass)
		} else {
			u.User = url.User(e.User)
		}
	}
	return u
}

func (e Entry) String() string { return e.URL().String() }

// HostPort 返回不含凭据的 host:port，用于日志与诊断展示。
func (e Entry) HostPort() string { return net.JoinHostPort(e.Host, e.Port) }

// Kind 返回协议类型（http/socks5 等），用于节点列表展示。
func (e Entry) Kind() string { return e.Scheme }

var supported = map[string]bool{
	"http": true, "https": true, "socks5": true, "socks5h": true,
}

// ParseContent 从订阅正文里解析出可用的 HTTP/SOCKS5 出口，返回 (entries, skipped)。
// 支持：纯文本 IP:PORT[(:USER:PASS)]、URI 行、base64 包裹、Clash YAML、sing-box JSON。
func ParseContent(raw string) ([]Entry, int) {
	content := normalize(raw)
	if decoded, ok := decodeWholeBase64(content); ok {
		content = decoded
	}

	// Clash YAML / sing-box JSON 都交给 yaml 解析（yaml 是 json 的超集）。
	if looksStructured(content) {
		if entries, ok := parseStructured(content); ok {
			return entries, 0
		}
	}

	var entries []Entry
	skipped := 0
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "//") {
			continue
		}
		e, ok := parseLine(line)
		if !ok {
			skipped++
			continue
		}
		entries = append(entries, e)
	}
	return entries, skipped
}

func normalize(s string) string {
	s = strings.TrimPrefix(s, "\uFEFF")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.TrimSpace(s)
}

// decodeWholeBase64 处理整段被 base64 包裹的订阅。
func decodeWholeBase64(s string) (string, bool) {
	compact := strings.Join(strings.Fields(s), "")
	if compact == "" || strings.ContainsAny(compact, "://") {
		return "", false
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(compact); err == nil {
			text := string(b)
			if strings.Contains(text, "://") || strings.Count(text, ":") >= 1 {
				if isMostlyPrintable(text) {
					return text, true
				}
			}
		}
	}
	return "", false
}

func isMostlyPrintable(s string) bool {
	if s == "" {
		return false
	}
	printable := 0
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' || (r >= 0x20 && r < 0x7f) {
			printable++
		}
	}
	return float64(printable)/float64(len(s)) > 0.9
}

func looksStructured(s string) bool {
	t := strings.TrimSpace(s)
	return strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[") ||
		strings.HasPrefix(t, "proxies:") || strings.Contains(t, "\nproxies:")
}

type clashDoc struct {
	Proxies []struct {
		Name     string `yaml:"name"`
		Type     string `yaml:"type"`
		Server   string `yaml:"server"`
		Port     any    `yaml:"port"`
		Username string `yaml:"username"`
		Password string `yaml:"password"`
	} `yaml:"proxies"`
}

type singboxDoc struct {
	Outbounds []struct {
		Type       string `yaml:"type"`
		Server     string `yaml:"server"`
		ServerPort any    `yaml:"server_port"`
		Username   string `yaml:"username"`
		Password   string `yaml:"password"`
	} `yaml:"outbounds"`
}

func parseStructured(s string) ([]Entry, bool) {
	var clash clashDoc
	if err := yaml.Unmarshal([]byte(s), &clash); err == nil && len(clash.Proxies) > 0 {
		entries := make([]Entry, 0, len(clash.Proxies))
		for _, p := range clash.Proxies {
			scheme := normalizeScheme(p.Type)
			if scheme == "" || p.Server == "" {
				continue
			}
			entries = append(entries, Entry{Scheme: scheme, Host: p.Server, Port: anyPort(p.Port), User: p.Username, Pass: p.Password})
		}
		return entries, true
	}

	var sb singboxDoc
	if err := json.Unmarshal([]byte(s), &sb); err == nil && len(sb.Outbounds) > 0 {
		entries := make([]Entry, 0, len(sb.Outbounds))
		for _, o := range sb.Outbounds {
			scheme := normalizeScheme(o.Type)
			if scheme == "" || o.Server == "" {
				continue
			}
			entries = append(entries, Entry{Scheme: scheme, Host: o.Server, Port: anyPort(o.ServerPort), User: o.Username, Pass: o.Password})
		}
		return entries, true
	}
	return nil, false
}

func normalizeScheme(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "http":
		return "http"
	case "https":
		return "https"
	case "socks", "socks5":
		return "socks5"
	case "socks5h":
		return "socks5h"
	default:
		return ""
	}
}

func anyPort(v any) string {
	switch t := v.(type) {
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case uint64:
		return strconv.FormatUint(t, 10)
	case float64:
		return strconv.Itoa(int(t))
	case string:
		return strings.TrimSpace(t)
	default:
		return ""
	}
}

func parseLine(line string) (Entry, bool) {
	if strings.Contains(line, "://") {
		u, err := url.Parse(line)
		if err != nil {
			return Entry{}, false
		}
		scheme := strings.ToLower(u.Scheme)
		if !supported[scheme] {
			return Entry{}, false // vmess/vless/trojan/ss 等先跳过
		}
		host := u.Hostname()
		port := u.Port()
		if host == "" || port == "" {
			return Entry{}, false
		}
		e := Entry{Scheme: scheme, Host: host, Port: port}
		if u.User != nil {
			e.User = u.User.Username()
			e.Pass, _ = u.User.Password()
		}
		return e, true
	}

	// 纯文本：IP:PORT 或 IP:PORT:USER:PASS（IPv6 用 [addr]:port 形式）
	parts := splitPlain(line)
	if len(parts) != 2 && len(parts) != 4 {
		return Entry{}, false
	}
	e := Entry{Scheme: "http", Host: parts[0], Port: parts[1]}
	if len(parts) == 4 {
		e.User, e.Pass = parts[2], parts[3]
	}
	return e, true
}

func splitPlain(line string) []string {
	if strings.HasPrefix(line, "[") {
		// [v6]:port[:user:pass]
		end := strings.Index(line, "]")
		if end < 0 {
			return nil
		}
		host := line[1:end]
		rest := strings.TrimPrefix(line[end+1:], ":")
		parts := strings.Split(rest, ":")
		out := append([]string{host}, parts...)
		return out
	}
	return strings.Split(line, ":")
}

var _ = fmt.Sprintf
