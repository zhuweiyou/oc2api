// Package config 收拢所有能由外部环境变量控制的配置：读一次、校验一次，
// 之后由 main 注入给下游，其余包不再直接碰 os.Getenv。
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Version 与发布标签保持一致，/health 直接透出。
const Version = "4.2.0"

// DefaultZenAPIBaseURL 只到站点根：具体路径由 zen 包拼，上游改路径时不用动部署配置。
const DefaultZenAPIBaseURL = "https://opencode.ai"

// DefaultZenConnectTimeout 与旧版一致：等响应头 60 秒。
const DefaultZenConnectTimeout = 60 * time.Second

// ZEN_CONNECT_TIMEOUT_MS 的允许区间，与旧版环境变量保持一致。
const (
	minZenConnectTimeoutMS = 1
	maxZenConnectTimeoutMS = 600000
)

// Config 是启动时定下来的配置快照，运行期不再变化。
type Config struct {
	// APIKey 留空表示匿名访问。
	APIKey string
	// Debug 只有字面量 "true" 才开启（"false" 在 Go 里也不是 true，但仍然显式比较更清楚）。
	Debug bool
	// Port 是 HTTP 监听端口，非法值回落 8080。
	Port string
	// ZenAPIBaseURL 是上游站点根地址，已去掉结尾斜杠，不含接口路径。
	ZenAPIBaseURL string
	// ZenConnectTimeout 同时覆盖建连、TLS 握手与等待响应头。
	ZenConnectTimeout time.Duration
}

// Load 读取并校验环境变量。不做缓存：由调用方在启动阶段调一次，再把结果注入下游。
func Load() (Config, error) {
	base, err := loadZenAPIBaseURL()
	if err != nil {
		return Config{}, err
	}
	timeout, err := loadZenConnectTimeout()
	if err != nil {
		return Config{}, err
	}
	return Config{
		APIKey:            strings.TrimSpace(os.Getenv("API_KEY")),
		Debug:             os.Getenv("DEBUG") == "true",
		Port:              loadPort(),
		ZenAPIBaseURL:     base,
		ZenConnectTimeout: timeout,
	}, nil
}

// loadZenAPIBaseURL 只接受站点根（可带一段前缀给反代用），结尾斜杠一律去掉。
func loadZenAPIBaseURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv("ZEN_API_BASE_URL"))
	if raw == "" {
		return DefaultZenAPIBaseURL, nil
	}
	value := strings.TrimRight(raw, "/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("ZEN_API_BASE_URL 必须是 http(s) 站点根地址，当前为 %q", raw)
	}
	return value, nil
}

// loadPort 与 Node 版一致：没填或不是合法端口时回落到 8080，不因为拼错而拒绝启动。
func loadPort() string {
	const fallback = "8080"
	raw := strings.TrimSpace(os.Getenv("PORT"))
	if raw == "" {
		return fallback
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return fallback
	}
	return strconv.Itoa(port)
}

func loadZenConnectTimeout() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("ZEN_CONNECT_TIMEOUT_MS"))
	if raw == "" {
		return DefaultZenConnectTimeout, nil
	}
	ms, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("ZEN_CONNECT_TIMEOUT_MS 必须是整数毫秒，当前为 %q", raw)
	}
	if ms < minZenConnectTimeoutMS || ms > maxZenConnectTimeoutMS {
		return 0, fmt.Errorf("ZEN_CONNECT_TIMEOUT_MS 必须在 %d 到 %d 毫秒之间，当前为 %d",
			minZenConnectTimeoutMS, maxZenConnectTimeoutMS, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
