package proxypool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

var (
	// ErrNotConfigured 表示没有配置订阅地址。
	ErrNotConfigured = errors.New("proxy subscription URL is empty")
	// ErrEmpty 表示订阅里没有可用的 http/socks5 出口。
	ErrEmpty = errors.New("no usable proxy entry in subscription")
)

const (
	maxSubscriptionBytes = 8 << 20
	rotationCooldown     = 60 * time.Second
)

// Pool 是「订阅地址 → 懒加载 IP 池 → 每次取一个」的实现。
// 第一次 Take 时才去拉订阅（冷启动不阻塞服务启动），之后轮询分配。
type Pool struct {
	url    string
	client *http.Client

	once    sync.Once
	loadErr error

	mu      sync.Mutex
	entries []*Entry
	next    int
	cooling map[*Entry]time.Time
}

// New 只保存订阅地址，不做任何网络请求。
func New(subscriptionURL string) *Pool {
	return &Pool{
		url:     subscriptionURL,
		client:  &http.Client{Timeout: 30 * time.Second},
		cooling: make(map[*Entry]time.Time),
	}
}

// Take 取一个可用出口；第一次调用会同步加载订阅。
func (p *Pool) Take(ctx context.Context) (*Entry, error) {
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	n := len(p.entries)
	for i := 0; i < n; i++ {
		e := p.entries[p.next%n]
		p.next = (p.next + 1) % n
		if until, ok := p.cooling[e]; ok && until.After(now) {
			continue
		}
		delete(p.cooling, e)
		return e, nil
	}
	// 全部在冷却：返回最早解冻的那个，别让请求直接失败。
	var best *Entry
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

// Report 把上游结果反馈给池子：429/403 等视为出口问题，冷却一阵子。
func (p *Pool) Report(e *Entry, status int) {
	if e == nil {
		return
	}
	switch status {
	case http.StatusForbidden, http.StatusTooManyRequests,
		http.StatusBadGateway, http.StatusGatewayTimeout:
		p.mu.Lock()
		p.cooling[e] = time.Now().Add(rotationCooldown)
		p.mu.Unlock()
	}
}

func (p *Pool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

func (p *Pool) load(ctx context.Context) error {
	p.once.Do(func() { p.loadErr = p.reload(ctx) })
	return p.loadErr
}

func (p *Pool) reload(ctx context.Context) error {
	if p.url == "" {
		return ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "oc2api-proxypool/1")
	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch subscription: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch subscription: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes))
	if err != nil {
		return err
	}
	parsed, skipped := ParseContent(string(body))
	if len(parsed) == 0 {
		return fmt.Errorf("%w (skipped %d unsupported lines)", ErrEmpty, skipped)
	}
	entries := make([]*Entry, 0, len(parsed))
	for i := range parsed {
		entries = append(entries, &parsed[i])
	}
	p.mu.Lock()
	p.entries = entries
	p.next = 0
	p.mu.Unlock()
	return nil
}
