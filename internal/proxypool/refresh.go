package proxypool

import (
	"context"
	"log"
	"sync"
	"time"
)

type nodeProbeResult struct {
	healthy bool
	latency time.Duration
}

// startRefreshLoop 定时重新拉取订阅。默认策略是「先把新节点探测完，再整体切换」，
// 这样刷新过程中旧节点一直可用，也不会把请求打到未验证的新节点上。
func (p *Pool) startRefreshLoop() {
	if p.skipProbe || p.refreshEvery <= 0 {
		return
	}
	p.refreshOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(p.refreshEvery)
			defer ticker.Stop()
			for range ticker.C {
				p.refreshSubscription(context.Background())
			}
		}()
	})
}

// refreshSubscription 拉取新订阅，先探测所有新增节点，再整体替换节点池。
// 拉取失败、解析为空、或新池探测后没有任何健康节点时，完整保留旧节点池。
func (p *Pool) refreshSubscription(ctx context.Context) {
	dialers, skipped, err := p.fetchDialers(ctx)
	if err != nil {
		log.Printf("[proxypool] subscription refresh failed, keeping existing nodes: %v", err)
		return
	}

	p.mu.Lock()
	oldStates := p.states
	oldCooling := p.cooling
	oldCount := len(p.entries)
	var newDialers []Dialer
	for _, d := range dialers {
		if _, ok := oldStates[d.Key()]; !ok {
			newDialers = append(newDialers, d)
		}
	}
	p.mu.Unlock()

	// 关键：新节点先在旧池之外探测完，再切换。
	results := map[string]nodeProbeResult{}
	if len(newDialers) > 0 {
		log.Printf("[proxypool] refresh probing %d new nodes before switching", len(newDialers))
		results = p.probeCandidates(newDialers)
	}

	now := time.Now()
	p.mu.Lock()
	states := make(map[string]*nodeState, len(dialers))
	cooling := make(map[string]time.Time, len(dialers))
	added, healthy := 0, 0
	for _, d := range dialers {
		key := d.Key()
		if st, ok := oldStates[key]; ok {
			states[key] = st
			if st.healthy {
				healthy++
			}
		} else {
			st := &nodeState{known: true, lastCheck: now}
			if result, ok := results[key]; ok {
				st.healthy = result.healthy
				st.latency = result.latency
			}
			states[key] = st
			added++
			if st.healthy {
				healthy++
			} else {
				cooling[key] = now.Add(failureCooldown)
			}
		}
		if until, ok := oldCooling[key]; ok && until.After(now) {
			cooling[key] = until
		}
	}
	if healthy == 0 {
		p.mu.Unlock()
		log.Printf("[proxypool] refresh produced 0 healthy nodes, keeping existing %d nodes", oldCount)
		return
	}

	p.entries = dialers
	p.next = 0
	p.states = states
	p.cooling = cooling
	if p.current != nil {
		if _, ok := states[p.current.Key()]; !ok {
			p.current = nil
		}
	}
	p.mu.Unlock()

	log.Printf("[proxypool] subscription refreshed: %d -> %d nodes (added=%d healthy=%d skipped=%d)",
		oldCount, len(dialers), added, healthy, skipped)
}

// probeCandidates 在切换前探测一批新节点，只返回结果，不改动当前节点池。
func (p *Pool) probeCandidates(entries []Dialer) map[string]nodeProbeResult {
	results := make(map[string]nodeProbeResult, len(entries))
	if p.skipProbe {
		return results
	}
	p.probeRunMu.Lock()
	defer p.probeRunMu.Unlock()

	jobs := make(chan Dialer)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i := 0; i < probeWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for d := range jobs {
				ok, latency := probeNode(context.Background(), d)
				mu.Lock()
				results[d.Key()] = nodeProbeResult{healthy: ok, latency: latency}
				mu.Unlock()
			}
		}()
	}
	for _, d := range entries {
		jobs <- d
	}
	close(jobs)
	wg.Wait()
	return results
}
