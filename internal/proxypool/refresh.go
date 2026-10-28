package proxypool

import (
	"context"
	"log"
	"time"
)

// startRefreshLoop 定时重新拉取订阅。只有成功解析出节点才替换；
// 拉取失败或解析为空时完整保留旧节点池，绝不清空。
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

// refreshSubscription 拉取新订阅并替换节点池，同时按稳定 Key 保留未变节点的状态。
func (p *Pool) refreshSubscription(ctx context.Context) {
	dialers, skipped, err := p.fetchDialers(ctx)
	if err != nil {
		log.Printf("[proxypool] subscription refresh failed, keeping existing nodes: %v", err)
		return
	}

	now := time.Now()
	p.mu.Lock()
	oldStates := p.states
	oldCooling := p.cooling
	states := make(map[string]*nodeState, len(dialers))
	cooling := make(map[string]time.Time, len(dialers))
	added := 0
	for _, d := range dialers {
		key := d.Key()
		if st, ok := oldStates[key]; ok {
			states[key] = st
		} else {
			states[key] = &nodeState{}
			added++
		}
		if until, ok := oldCooling[key]; ok && until.After(now) {
			cooling[key] = until
		}
	}
	oldCount := len(p.entries)
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

	log.Printf("[proxypool] subscription refreshed: %d -> %d nodes (added=%d skipped=%d)",
		oldCount, len(dialers), added, skipped)
	if added > 0 {
		go p.probeNew(dialers)
	}
}

// probeNew 立即探测刷新后新增、还没有状态的节点，避免等下一个健康检查周期。
func (p *Pool) probeNew(dialers []Dialer) {
	p.mu.Lock()
	targets := make([]Dialer, 0, len(dialers))
	for _, d := range dialers {
		if st := p.states[d.Key()]; st == nil || !st.known {
			targets = append(targets, d)
		}
	}
	p.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	healthy := p.probeBatch(targets, false)
	log.Printf("[proxypool] new nodes probed: scanned=%d healthy=%d", len(targets), healthy)
}
