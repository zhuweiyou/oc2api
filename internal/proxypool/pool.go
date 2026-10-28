package proxypool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	// ErrNotConfigured 表示没有配置订阅地址。
	ErrNotConfigured = errors.New("proxy subscription URL is empty")
	// ErrEmpty 表示订阅里没有可用的出口。
	ErrEmpty = errors.New("no usable node in subscription")
)

const (
	maxSubscriptionBytes = 8 << 20
	// quotaCooldown：429/403 是出口额度问题，短暂冷却后可能恢复。
	quotaCooldown = 60 * time.Second
	// failureCooldown：传输失败（EOF/超时/认证失败）说明节点本身挂了，
	// 冷却久一点，避免每条请求都反复踩同一个死节点。
	failureCooldown = 10 * time.Minute
	// probeWait：第一次请求最多等这么久看有没有探出健康节点。
	probeWait = 8 * time.Second
)

type nodeState struct {
	healthy   bool
	known     bool
	latency   time.Duration
	lastCheck time.Time
}

// Pool 是「订阅地址 → 节点池 → 每次取一个」的实现。
// 启动时调用 Start 加载订阅并开始健康探测；未调用 Start 时 Take 会兜底加载。
// 节点状态按 Dialer.Key() 存，订阅刷新后未变的节点能保留状态。
type Pool struct {
	url    string
	client *http.Client

	loadMu sync.Mutex
	loaded bool

	probeOnce      sync.Once
	probeReady     chan struct{}
	probeReadyOnce sync.Once
	probeRunMu     sync.Mutex
	firstWait      time.Duration
	skipProbe      bool
	healthOnce     sync.Once
	healthInterval time.Duration
	refreshOnce    sync.Once
	refreshEvery   time.Duration

	mu       sync.Mutex
	entries  []Dialer
	next     int
	current  Dialer
	strategy Strategy
	cooling  map[string]time.Time
	states   map[string]*nodeState
}

// New 只保存订阅地址、健康检查/刷新间隔与选节点策略，不做任何网络请求。
func New(subscriptionURL string, healthInterval, refreshInterval time.Duration, strategy Strategy) *Pool {
	return &Pool{
		url:            subscriptionURL,
		client:         &http.Client{Timeout: 30 * time.Second},
		cooling:        make(map[string]time.Time),
		states:         make(map[string]*nodeState),
		firstWait:      probeWait,
		healthInterval: healthInterval,
		refreshEvery:   refreshInterval,
		strategy:       ParseStrategy(string(strategy)),
	}
}

// Start 在启动阶段加载订阅并触发健康探测，之后定时健康检查与订阅刷新。
func (p *Pool) Start(ctx context.Context) error {
	return p.load(ctx)
}

// Take 取一个可用节点；优先健康节点，其次未探测过的，最后才是还在冷却里的。
func (p *Pool) Take(ctx context.Context) (Dialer, error) {
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	p.waitProbe(ctx)

	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) == 0 {
		return nil, ErrEmpty
	}
	now := time.Now()

	if p.strategy == StrategySticky {
		if p.current != nil {
			if p.usableLocked(p.current, now) {
				return p.current, nil
			}
			p.current = nil
		}
	}

	e := p.pickLocked(now)
	if e == nil {
		return nil, ErrEmpty
	}
	if p.strategy == StrategySticky {
		p.current = e
	}
	return e, nil
}

// usableLocked 判断当前节点还能不能继续用（不在冷却，且不是已判定不健康）。
func (p *Pool) usableLocked(e Dialer, now time.Time) bool {
	if p.coolingActiveLocked(e.Key(), now) {
		return false
	}
	if st := p.states[e.Key()]; st != nil && st.known && !st.healthy {
		return false
	}
	return true
}

// pickLocked 按「健康 → 未探测 → 其它未冷却 → 最早解冻」的顺序挑一个节点。
func (p *Pool) pickLocked(now time.Time) Dialer {
	n := len(p.entries)

	// 1) 健康且不在冷却
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e.Key(), now) {
			continue
		}
		if st := p.states[e.Key()]; st != nil && st.healthy {
			return e
		}
	}
	// 2) 还没探测过且不在冷却（边用边探）
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e.Key(), now) {
			continue
		}
		if st := p.states[e.Key()]; st == nil || !st.known {
			return e
		}
	}
	// 3) 探测过但暂时没判死的
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e.Key(), now) {
			continue
		}
		return e
	}
	// 全部冷却：返回最早解冻的那个，别让请求直接失败。
	var best Dialer
	var bestUntil time.Time
	for _, e := range p.entries {
		until := p.cooling[e.Key()]
		if best == nil || until.Before(bestUntil) {
			best, bestUntil = e, until
		}
	}
	return best
}

// Report 把结果反馈给池子：2xx 标健康，429/403 短期冷却，传输错误长期冷却。
func (p *Pool) Report(e Dialer, status int) {
	if e == nil {
		return
	}
	key := e.Key()
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.states[key]
	if st == nil {
		st = &nodeState{}
		p.states[key] = st
	}
	switch {
	case status >= 200 && status < 300:
		st.healthy = true
		st.known = true
		delete(p.cooling, key)
	case status == http.StatusForbidden || status == http.StatusTooManyRequests:
		p.coolLocked(key, quotaCooldown)
		if p.current != nil && p.current.Key() == key {
			p.current = nil
		}
	case status >= 500:
		st.healthy = false
		st.known = true
		p.coolLocked(key, failureCooldown)
		if p.current != nil && p.current.Key() == key {
			p.current = nil
		}
	}
}

func (p *Pool) coolLocked(key string, d time.Duration) {
	until := time.Now().Add(d)
	if existing, ok := p.cooling[key]; !ok || until.After(existing) {
		p.cooling[key] = until
	}
}

func (p *Pool) coolingActiveLocked(key string, now time.Time) bool {
	until, ok := p.cooling[key]
	if !ok {
		return false
	}
	if until.After(now) {
		return true
	}
	delete(p.cooling, key)
	return false
}

// Size 返回节点总数。
func (p *Pool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

// Stats 返回池子的健康度快照，供 /health 展示。
func (p *Pool) Stats() (total, healthy, coolingCount, unknown int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	total = len(p.entries)
	for _, e := range p.entries {
		st := p.states[e.Key()]
		if st != nil && st.healthy {
			healthy++
		}
		if st == nil || !st.known {
			unknown++
		}
		if until, ok := p.cooling[e.Key()]; ok && until.After(now) {
			coolingCount++
		}
	}
	return
}

// NodeInfo 是节点在诊断接口里的可见视图（不含服务器地址与凭据）。
type NodeInfo struct {
	Label     string `json:"label"`
	Kind      string `json:"kind"`
	Healthy   bool   `json:"healthy"`
	Known     bool   `json:"known"`
	Cooling   bool   `json:"cooling"`
	LatencyMS int64  `json:"latency_ms"`
	LastCheck string `json:"last_check,omitempty"`
}

// Strategy 返回当前的节点选择策略。
func (p *Pool) Strategy() string {
	return string(p.strategy)
}

// Nodes 返回节点列表；state 支持 healthy（默认）、unhealthy、cooling、all。
func (p *Pool) Nodes(state string) []NodeInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	out := make([]NodeInfo, 0, len(p.entries))
	for _, e := range p.entries {
		st := p.states[e.Key()]
		info := NodeInfo{Label: e.Label()}
		if kinded, ok := e.(interface{ Kind() string }); ok {
			info.Kind = kinded.Kind()
		}
		if st != nil {
			info.Healthy = st.healthy
			info.Known = st.known
			info.LatencyMS = st.latency.Milliseconds()
			if !st.lastCheck.IsZero() {
				info.LastCheck = st.lastCheck.Format(time.RFC3339)
			}
		}
		if until, ok := p.cooling[e.Key()]; ok && until.After(now) {
			info.Cooling = true
		}
		switch state {
		case "healthy":
			if !info.Healthy {
				continue
			}
		case "unhealthy":
			if !info.Known || info.Healthy {
				continue
			}
		case "cooling":
			if !info.Cooling {
				continue
			}
		}
		out = append(out, info)
	}
	return out
}

func (p *Pool) load(ctx context.Context) error {
	p.mu.Lock()
	if p.loaded {
		p.mu.Unlock()
		return nil
	}
	p.mu.Unlock()

	// 只让一个协程去拉订阅（启动阶段或首个请求兜底）；失败不缓存，下次会重试。
	p.loadMu.Lock()
	defer p.loadMu.Unlock()
	p.mu.Lock()
	if p.loaded {
		p.mu.Unlock()
		return nil
	}
	p.mu.Unlock()

	if err := p.reload(ctx); err != nil {
		return err
	}
	p.mu.Lock()
	p.loaded = true
	p.mu.Unlock()
	p.startProbe()
	p.startHealthLoop()
	p.startRefreshLoop()
	return nil
}

func (p *Pool) reload(ctx context.Context) error {
	dialers, skipped, err := p.fetchDialers(ctx)
	if err != nil {
		return err
	}
	states := make(map[string]*nodeState, len(dialers))
	for _, d := range dialers {
		states[d.Key()] = &nodeState{}
	}
	p.mu.Lock()
	p.entries = dialers
	p.next = 0
	p.cooling = make(map[string]time.Time)
	p.states = states
	p.mu.Unlock()
	log.Printf("[proxypool] subscription loaded: %d nodes (skipped %d)", len(dialers), skipped)
	return nil
}

// fetchDialers 拉取并解析订阅；只有成功且至少一个节点时才返回 nil error。
func (p *Pool) fetchDialers(ctx context.Context) ([]Dialer, int, error) {
	if p.url == "" {
		return nil, 0, ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return nil, 0, p.redact(err)
	}
	req.Header.Set("User-Agent", "oc2api-proxypool/1")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, 0, p.redact(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("fetch subscription: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes))
	if err != nil {
		return nil, 0, err
	}
	dialers, skipped := ParseSubscription(body)
	if len(dialers) == 0 {
		return nil, skipped, fmt.Errorf("%w (skipped %d unsupported entries)", ErrEmpty, skipped)
	}
	return dialers, skipped, nil
}

// redact 把错误信息里的订阅地址替换掉，避免把带 token 的 URL 写进日志或返回给客户端。
func (p *Pool) redact(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if p.url != "" {
		message = strings.ReplaceAll(message, p.url, "<subscription>")
	}
	return errors.New(message)
}
