package proxypool

import (
	"context"
	"crypto/tls"
	"log"
	"sync"
	"time"
)

const (
	probeWorkers = 16
	probeTimeout = 7 * time.Second
	// healthyRecheck 是健康节点的复检周期：定时健康检查里，超过这个时间没测过的
	// 健康节点会再测一次，防止节点悄悄失效。
	healthyRecheck = 30 * time.Minute
)

// startProbe 在订阅加载完成后后台并发探测所有节点，不阻塞第一次请求。
func (p *Pool) startProbe() {
	if p.skipProbe {
		return
	}
	p.probeOnce.Do(func() {
		p.mu.Lock()
		p.probeReady = make(chan struct{})
		entries := append([]Dialer(nil), p.entries...)
		p.mu.Unlock()
		go p.probeAll(entries)
	})
}

// startHealthLoop 启动定时健康检查：死节点冷却到期后重试，健康节点定期复检。
func (p *Pool) startHealthLoop() {
	if p.skipProbe || p.healthInterval <= 0 {
		return
	}
	p.healthOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(p.healthInterval)
			defer ticker.Stop()
			for range ticker.C {
				p.probeDue()
			}
		}()
	})
}

// probeDue 挑出「冷却已到期的死节点 + 超过复检周期的健康节点 + 还没测过的节点」重测。
func (p *Pool) probeDue() {
	now := time.Now()
	p.mu.Lock()
	var targets []Dialer
	for _, d := range p.entries {
		st := p.states[d.Key()]
		if st == nil || !st.known {
			targets = append(targets, d)
			continue
		}
		if st.healthy {
			if now.Sub(st.lastCheck) >= healthyRecheck {
				targets = append(targets, d)
			}
			continue
		}
		// 死节点每轮都重试（冷却只影响“被选中服务”，不影响探测）。
		targets = append(targets, d)
	}
	p.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	log.Printf("[proxypool] health check start: targets=%d", len(targets))
	healthy := p.probeBatch(targets, false)
	log.Printf("[proxypool] health check done: scanned=%d healthy=%d", len(targets), healthy)
}

// waitProbe 让第一次请求最多等 probeWait，看能不能等到健康节点消息。
func (p *Pool) waitProbe(ctx context.Context) {
	if p.skipProbe || p.firstWait <= 0 {
		return
	}
	p.mu.Lock()
	ch := p.probeReady
	p.mu.Unlock()
	if ch == nil {
		return
	}
	timer := time.NewTimer(p.firstWait)
	defer timer.Stop()
	select {
	case <-ch:
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (p *Pool) probeAll(entries []Dialer) {
	started := time.Now()
	healthy := p.probeBatch(entries, true)
	p.probeReadyOnce.Do(func() { close(p.probeReady) })
	log.Printf("[proxypool] probe done: total=%d healthy=%d dead=%d in %s",
		len(entries), healthy, len(entries)-healthy, time.Since(started).Round(time.Second))
}

// probeBatch 并发探测一批节点，返回健康数量。initial 为真时，一旦出现第一个健康
// 节点就关闭 probeReady，让第一次请求能尽快放行。
func (p *Pool) probeBatch(entries []Dialer, initial bool) int {
	if !p.probeRunMu.TryLock() {
		return 0 // 上一轮还没跑完，跳过这一轮，避免叠加
	}
	defer p.probeRunMu.Unlock()

	jobs := make(chan Dialer)
	var wg sync.WaitGroup
	var mu sync.Mutex
	healthy := 0

	for i := 0; i < probeWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for d := range jobs {
				ok, latency := probeNode(context.Background(), d)
				p.mu.Lock()
				st := p.states[d.Key()]
				if st == nil {
					st = &nodeState{}
					p.states[d.Key()] = st
				}
				st.known = true
				st.latency = latency
				st.lastCheck = time.Now()
				if ok {
					st.healthy = true
					delete(p.cooling, d.Key())
				} else {
					st.healthy = false
					p.coolLocked(d.Key(), failureCooldown)
				}
				p.mu.Unlock()
				if ok {
					mu.Lock()
					healthy++
					if initial && healthy == 1 {
						p.probeReadyOnce.Do(func() { close(p.probeReady) })
					}
					mu.Unlock()
				}
			}
		}()
	}

	for _, d := range entries {
		jobs <- d
	}
	close(jobs)
	wg.Wait()
	return healthy
}

// probeNode 做两段真实 TLS 握手：先 1.1.1.1 验隧道，再 opencode.ai 验目标可达。
// 只握手不发 HTTP，不消耗上游额度。
func probeNode(ctx context.Context, d Dialer) (bool, time.Duration) {
	started := time.Now()
	if err := tlsProbe(ctx, d, "1.1.1.1:443", "1.1.1.1", true); err != nil {
		return false, 0
	}
	if err := tlsProbe(ctx, d, "opencode.ai:443", "opencode.ai", false); err != nil {
		return false, 0
	}
	return true, time.Since(started)
}

func tlsProbe(ctx context.Context, d Dialer, addr, serverName string, insecure bool) error {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	conn, err := d.Dial(probeCtx, "tcp", addr)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	if deadline, ok := probeCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         serverName,
		NextProtos:         []string{"http/1.1"},
		InsecureSkipVerify: insecure,
	})
	return tlsConn.HandshakeContext(probeCtx)
}
