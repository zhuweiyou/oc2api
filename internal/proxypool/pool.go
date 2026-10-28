package proxypool

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	healthy bool
	known   bool
	latency time.Duration
}

// Pool 是「订阅地址 → 懒加载节点池 → 每次取一个」的实现。
// 第一次 Take 时才去拉订阅（冷启动不阻塞服务启动），随后后台探测节点健康度。
type Pool struct {
	url    string
	client *http.Client

	loadMu sync.Mutex
	loaded bool

	probeOnce      sync.Once
	probeReady     chan struct{}
	probeReadyOnce sync.Once
	firstWait      time.Duration
	skipProbe      bool

	mu      sync.Mutex
	entries []Dialer
	next    int
	cooling map[Dialer]time.Time
	states  map[Dialer]*nodeState
}

// New 只保存订阅地址，不做任何网络请求。
func New(subscriptionURL string) *Pool {
	return &Pool{
		url:       subscriptionURL,
		client:    &http.Client{Timeout: 30 * time.Second},
		cooling:   make(map[Dialer]time.Time),
		states:    make(map[Dialer]*nodeState),
		firstWait: probeWait,
	}
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
	n := len(p.entries)

	// 1) 健康且不在冷却
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e, now) {
			continue
		}
		if st := p.states[e]; st != nil && st.healthy {
			return e, nil
		}
	}
	// 2) 还没探测过且不在冷却（边用边探）
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e, now) {
			continue
		}
		if st := p.states[e]; st == nil || !st.known {
			return e, nil
		}
	}
	// 3) 探测过但暂时没判死的
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if p.coolingActiveLocked(e, now) {
			continue
		}
		return e, nil
	}
	// 全部冷却：返回最早解冻的那个，别让请求直接失败。
	var best Dialer
	var bestUntil time.Time
	for _, e := range p.entries {
		until := p.cooling[e]
		if best == nil || until.Before(bestUntil) {
			best, bestUntil = e, until
		}
	}
	if best == nil {
		return nil, ErrEmpty
	}
	return best, nil
}

// Report 把结果反馈给池子：2xx 标健康，429/403 短期冷却，传输错误长期冷却。
func (p *Pool) Report(e Dialer, status int) {
	if e == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.states[e]
	if st == nil {
		st = &nodeState{}
		p.states[e] = st
	}
	switch {
	case status >= 200 && status < 300:
		st.healthy = true
		st.known = true
		delete(p.cooling, e)
	case status == http.StatusForbidden || status == http.StatusTooManyRequests:
		p.coolLocked(e, quotaCooldown)
	case status >= 500:
		st.healthy = false
		st.known = true
		p.coolLocked(e, failureCooldown)
	}
}

func (p *Pool) coolLocked(e Dialer, d time.Duration) {
	until := time.Now().Add(d)
	if existing, ok := p.cooling[e]; !ok || until.After(existing) {
		p.cooling[e] = until
	}
}

func (p *Pool) coolingActiveLocked(e Dialer, now time.Time) bool {
	until, ok := p.cooling[e]
	if !ok {
		return false
	}
	if until.After(now) {
		return true
	}
	delete(p.cooling, e)
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
		st := p.states[e]
		if st != nil && st.healthy {
			healthy++
		}
		if st == nil || !st.known {
			unknown++
		}
		if until, ok := p.cooling[e]; ok && until.After(now) {
			coolingCount++
		}
	}
	return
}

func (p *Pool) load(ctx context.Context) error {
	p.mu.Lock()
	if p.loaded {
		p.mu.Unlock()
		return nil
	}
	p.mu.Unlock()

	// 只让一个请求去拉订阅；失败不缓存，下一次请求会重试。
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
	return nil
}

func (p *Pool) reload(ctx context.Context) error {
	if p.url == "" {
		return ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return p.redact(err)
	}
	req.Header.Set("User-Agent", "oc2api-proxypool/1")
	resp, err := p.client.Do(req)
	if err != nil {
		return p.redact(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch subscription: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes))
	if err != nil {
		return err
	}
	dialers, skipped := ParseSubscription(body)
	if len(dialers) == 0 {
		return fmt.Errorf("%w (skipped %d unsupported entries)", ErrEmpty, skipped)
	}
	p.mu.Lock()
	p.entries = dialers
	p.next = 0
	p.states = make(map[Dialer]*nodeState, len(dialers))
	for _, d := range dialers {
		p.states[d] = &nodeState{}
	}
	p.mu.Unlock()
	return nil
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
