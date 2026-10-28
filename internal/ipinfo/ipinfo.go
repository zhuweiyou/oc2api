// Package ipinfo 查询出口 IP：多个供应商并发竞速，谁先返回有效 IP 用谁。
package ipinfo

import (
	"context"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	ipv4Pattern = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)
	ipv6Pattern = regexp.MustCompile(`[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}`)
)

const providerTimeout = 8 * time.Second

// Result 是某个供应商返回的出口信息。Warp/Loc/Colo 只有 Cloudflare trace 会给。
type Result struct {
	IP     string
	Source string
	Warp   string
	Loc    string
	Colo   string
}

type provider struct {
	name  string
	fetch func(*http.Client) Result
}

var providers = []provider{
	{"https://api.ipquery.io", fetchIPQuery},
	{"http://ip-api.com/json", fetchIPAPI},
	{"https://1.1.1.1/cdn-cgi/trace", fetchCloudflareTrace},
}

// Lookup 返回第一个可用的出口 IP 与来源供应商。
func Lookup(client *http.Client) (string, string) {
	result := LookupResult(client)
	return result.IP, result.Source
}

// LookupResult 并发请求所有供应商，返回第一个拿到有效 IP 的结果。
func LookupResult(client *http.Client) Result {
	if client == nil {
		client = &http.Client{}
	}
	results := make(chan Result, len(providers))
	for _, p := range providers {
		go func(p provider) { results <- p.fetch(client) }(p)
	}
	for range providers {
		if result := <-results; result.IP != "" {
			return result
		}
	}
	return Result{}
}

func fetchIPQuery(client *http.Client) Result {
	return fetchGeneric(client, "https://api.ipquery.io")
}

func fetchIPAPI(client *http.Client) Result {
	return fetchGeneric(client, "http://ip-api.com/json")
}

// fetchGeneric 从普通 IP 查询接口里抓第一个合法 IPv4/IPv6。
func fetchGeneric(client *http.Client, source string) Result {
	body, ok := getBody(client, source)
	if !ok {
		return Result{}
	}
	if ip := findIP(string(body)); ip != "" {
		return Result{IP: ip, Source: source}
	}
	return Result{}
}

// fetchCloudflareTrace 解析 https://1.1.1.1/cdn-cgi/trace，同时拿到 warp/loc/colo。
func fetchCloudflareTrace(client *http.Client) Result {
	body, ok := getBody(client, "https://1.1.1.1/cdn-cgi/trace")
	if !ok {
		return Result{}
	}
	return parseTrace(string(body))
}

func parseTrace(body string) Result {
	result := Result{Source: "https://1.1.1.1/cdn-cgi/trace"}
	for _, line := range strings.Split(body, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "ip":
			if net.ParseIP(value) != nil {
				result.IP = value
			}
		case "warp":
			result.Warp = value
		case "loc":
			result.Loc = value
		case "colo":
			result.Colo = value
		}
	}
	return result
}

func findIP(text string) string {
	if match := ipv4Pattern.FindString(text); match != "" && net.ParseIP(match) != nil {
		return match
	}
	for _, match := range ipv6Pattern.FindAllString(text, -1) {
		if ip := net.ParseIP(match); ip != nil && ip.To4() == nil {
			return ip.String()
		}
	}
	return ""
}

func getBody(client *http.Client, source string) ([]byte, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), providerTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, false
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return nil, false
	}
	return body, true
}
