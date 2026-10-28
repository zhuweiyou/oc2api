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
const Version = "4.4.0"

// DefaultZenAPIBaseURL 只到站点根：具体路径由 zen 包拼，上游改路径时不用动部署配置。
const DefaultZenAPIBaseURL = "https://opencode.ai"

// DefaultZenConnectTimeout 与旧版一致：等响应头 60 秒。
const DefaultZenConnectTimeout = 60 * time.Second

// ZEN_CONNECT_TIMEOUT_MS 的允许区间，与旧版环境变量保持一致。
const (
	minZenConnectTimeoutMS = 1
	maxZenConnectTimeoutMS = 600000
)

// PROXY_MAX_ATTEMPTS 默认值与区间：订阅代理模式下，429/403 时最多换几个出口。
const (
	DefaultProxyMaxAttempts = 5
	minProxyMaxAttempts     = 1
	maxProxyMaxAttempts     = 10
)

// PROXY_HEALTH_INTERVAL_SECONDS：定时健康检查间隔，0 表示关闭。
const (
	DefaultProxyHealthInterval = 10 * time.Minute
	minProxyHealthInterval     = time.Minute
	maxProxyHealthInterval     = 24 * time.Hour
)

// PROXY_STRATEGY：节点选择策略。sticky=填充（默认，用到不可用再换），
// round_robin=轮询（每次请求换一个）。
const (
	DefaultProxyStrategy = "sticky"
	ProxyStrategySticky  = "sticky"
	ProxyStrategyRR      = "round_robin"
)

// PROXY_SUBSCRIPTION_REFRESH_SECONDS：定时重新拉取订阅的间隔，0 表示不刷新。
const (
	DefaultProxyRefreshInterval = 30 * time.Minute
	minProxyRefreshInterval     = 5 * time.Minute
	maxProxyRefreshInterval     = 24 * time.Hour
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
	// ProxySubscriptionURL 非空时启用「订阅节点池」：启动时拉取订阅并开始
	// 健康探测，之后每个请求轮换使用。留空则保持直连。
	ProxySubscriptionURL string
	// ProxyMaxAttempts 是遇到 429/403 时最多尝试的出口数（含首次）。
	ProxyMaxAttempts int
	// ProxyHealthInterval 是定时健康检查间隔；0 表示只在加载时探测一次。
	ProxyHealthInterval time.Duration
	// ProxyRefreshInterval 是定时重新拉取订阅的间隔；0 表示不刷新。
	ProxyRefreshInterval time.Duration
	// ProxyStrategy 是节点选择策略：sticky（默认，填充）或 round_robin（轮询）。
	ProxyStrategy string
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
	proxyURL, err := loadProxySubscriptionURL()
	if err != nil {
		return Config{}, err
	}
	proxyAttempts, err := loadProxyMaxAttempts()
	if err != nil {
		return Config{}, err
	}
	proxyHealth, err := loadProxyHealthInterval()
	if err != nil {
		return Config{}, err
	}
	proxyRefresh, err := loadProxyRefreshInterval()
	if err != nil {
		return Config{}, err
	}
	proxyStrategy, err := loadProxyStrategy()
	if err != nil {
		return Config{}, err
	}
	return Config{
		APIKey:               strings.TrimSpace(os.Getenv("API_KEY")),
		Debug:                os.Getenv("DEBUG") == "true",
		Port:                 loadPort(),
		ZenAPIBaseURL:        base,
		ZenConnectTimeout:    timeout,
		ProxySubscriptionURL: proxyURL,
		ProxyMaxAttempts:     proxyAttempts,
		ProxyHealthInterval:  proxyHealth,
		ProxyRefreshInterval: proxyRefresh,
		ProxyStrategy:        proxyStrategy,
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

// loadProxySubscriptionURL 允许为空（关闭代理池）；非空时必须是 http(s) 订阅地址。
func loadProxySubscriptionURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv("PROXY_SUBSCRIPTION_URL"))
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("PROXY_SUBSCRIPTION_URL 必须是 http(s) 订阅地址，当前为 %q", raw)
	}
	return raw, nil
}

func loadProxyMaxAttempts() (int, error) {
	raw := strings.TrimSpace(os.Getenv("PROXY_MAX_ATTEMPTS"))
	if raw == "" {
		return DefaultProxyMaxAttempts, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("PROXY_MAX_ATTEMPTS 必须是整数，当前为 %q", raw)
	}
	if value < minProxyMaxAttempts || value > maxProxyMaxAttempts {
		return 0, fmt.Errorf("PROXY_MAX_ATTEMPTS 必须在 %d 到 %d 之间，当前为 %d",
			minProxyMaxAttempts, maxProxyMaxAttempts, value)
	}
	return value, nil
}

// loadProxyHealthInterval 允许 0（关闭定时检查）；非 0 时限制在 1 分钟到 24 小时。
func loadProxyHealthInterval() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("PROXY_HEALTH_INTERVAL_SECONDS"))
	if raw == "" {
		return DefaultProxyHealthInterval, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("PROXY_HEALTH_INTERVAL_SECONDS 必须是整数秒，当前为 %q", raw)
	}
	if seconds == 0 {
		return 0, nil
	}
	interval := time.Duration(seconds) * time.Second
	if interval < minProxyHealthInterval || interval > maxProxyHealthInterval {
		return 0, fmt.Errorf("PROXY_HEALTH_INTERVAL_SECONDS 必须是 0 或 %d 到 %d 秒，当前为 %d",
			int(minProxyHealthInterval.Seconds()), int(maxProxyHealthInterval.Seconds()), seconds)
	}
	return interval, nil
}

// loadProxyRefreshInterval 允许 0（不刷新）；非 0 时限制在 5 分钟到 24 小时。
func loadProxyRefreshInterval() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("PROXY_SUBSCRIPTION_REFRESH_SECONDS"))
	if raw == "" {
		return DefaultProxyRefreshInterval, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("PROXY_SUBSCRIPTION_REFRESH_SECONDS 必须是整数秒，当前为 %q", raw)
	}
	if seconds == 0 {
		return 0, nil
	}
	interval := time.Duration(seconds) * time.Second
	if interval < minProxyRefreshInterval || interval > maxProxyRefreshInterval {
		return 0, fmt.Errorf("PROXY_SUBSCRIPTION_REFRESH_SECONDS 必须是 0 或 %d 到 %d 秒，当前为 %d",
			int(minProxyRefreshInterval.Seconds()), int(maxProxyRefreshInterval.Seconds()), seconds)
	}
	return interval, nil
}

// loadProxyStrategy 归一化节点选择策略；未知值直接报错，避免“以为在轮询其实一直是填充”。
func loadProxyStrategy() (string, error) {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv("PROXY_STRATEGY")))
	switch raw {
	case "", "sticky", "fill", "sticky-until-failure":
		return ProxyStrategySticky, nil
	case "round_robin", "round-robin", "rr", "roundrobin", "polling":
		return ProxyStrategyRR, nil
	default:
		return "", fmt.Errorf("PROXY_STRATEGY 只能是 sticky（填充）或 round_robin（轮询），当前为 %q", raw)
	}
}
