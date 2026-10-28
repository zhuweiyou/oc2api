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
				st := p.states[d]
				if st == nil {
					st = &nodeState{}
					p.states[d] = st
				}
				st.known = true
				st.latency = latency
				if ok {
					st.healthy = true
					delete(p.cooling, d)
				} else {
					st.healthy = false
					p.coolLocked(d, failureCooldown)
				}
				p.mu.Unlock()
				if ok {
					mu.Lock()
					healthy++
					if healthy == 1 {
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

	p.probeReadyOnce.Do(func() { close(p.probeReady) })
	log.Printf("[proxypool] probe done: total=%d healthy=%d dead=%d in %s",
		len(entries), healthy, len(entries)-healthy, time.Since(started).Round(time.Second))
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
	defer conn.Close()
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
