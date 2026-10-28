package proxypool

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestParseFormats(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
		skip int
	}{
		{"plain", "1.2.3.4:8080\n5.6.7.8:1080:user:pass\n", 2, 0},
		{"uri", "http://u:p@1.2.3.4:8080\nsocks5://5.6.7.8:1080\nvmess://xxx\n", 2, 1},
		{"base64", base64.StdEncoding.EncodeToString([]byte("http://1.2.3.4:8080\nsocks5://5.6.7.8:1080\n")), 2, 0},
		{"clash", "proxies:\n  - name: a\n    type: http\n    server: 1.2.3.4\n    port: 8080\n    username: u\n    password: p\n  - name: b\n    type: socks5\n    server: 5.6.7.8\n    port: 1080\n", 2, 0},
		{"singbox", `{"outbounds":[{"type":"socks","server":"1.2.3.4","server_port":1080,"username":"u","password":"p"}]}`, 1, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, skipped := ParseContent(c.in)
			if len(got) != c.want || skipped != c.skip {
				t.Fatalf("got %d entries, %d skipped; want %d, %d (%v)", len(got), skipped, c.want, c.skip, got)
			}
		})
	}
}

func TestTakeLazyLoadAndRotate(t *testing.T) {
	body := "http://1.2.3.4:8080\nhttp://5.6.7.8:8080\nsocks5://9.9.9.9:1080\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	p := New(srv.URL, 0, 0, StrategyRoundRobin)
	p.skipProbe = true
	if p.Size() != 0 {
		t.Fatalf("pool must be empty before first Take")
	}
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		e, err := p.Take(context.Background())
		if err != nil {
			t.Fatalf("Take: %v", err)
		}
		seen[e.Label()] = true
	}
	if len(seen) != 3 {
		t.Fatalf("expected 3 distinct exits, got %v", seen)
	}
	if p.Size() != 3 {
		t.Fatalf("size = %d, want 3", p.Size())
	}
}

func TestCooldownSkipsFailedExit(t *testing.T) {
	body := "http://1.1.1.1:8080\nhttp://2.2.2.2:8080\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	p := New(srv.URL, 0, 0, StrategySticky)
	p.skipProbe = true
	first, _ := p.Take(context.Background())
	p.Report(first, http.StatusTooManyRequests)
	for i := 0; i < 5; i++ {
		e, err := p.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if e.Label() == first.Label() {
			t.Fatalf("cooled exit %s must be skipped", e)
		}
	}
}

func TestEmptyURL(t *testing.T) {
	if _, err := New("", 0, 0, StrategySticky).Take(context.Background()); err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestErrorRedactsSubscription(t *testing.T) {
	const secret = "https://secret.example/token123"
	p := New(secret, 0, 0, StrategySticky)
	err := p.redact(errors.New(`Get "` + secret + `": dial failed`))
	if strings.Contains(err.Error(), "token123") {
		t.Fatalf("error leaks subscription token: %v", err)
	}
	if !strings.Contains(err.Error(), "<subscription>") {
		t.Fatalf("error was not redacted: %v", err)
	}
}

func TestLoadRetriesAfterFailure(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("http://1.2.3.4:8080\n"))
	}))
	defer srv.Close()

	p := New(srv.URL, 0, 0, StrategySticky)
	p.skipProbe = true
	if _, err := p.Take(context.Background()); err == nil {
		t.Fatal("first Take should fail because subscription returns 500")
	}
	entry, err := p.Take(context.Background())
	if err != nil {
		t.Fatalf("second Take should retry and succeed: %v", err)
	}
	if entry.Label() != "1.2.3.4:8080" {
		t.Fatalf("entry = %s", entry.Label())
	}
}

func newTwoNodePool(t *testing.T, strategy Strategy) *Pool {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("http://1.1.1.1:8080\nhttp://2.2.2.2:8080\n"))
	}))
	t.Cleanup(srv.Close)
	p := New(srv.URL, 0, 0, strategy)
	p.skipProbe = true
	return p
}

func TestStickyKeepsNodeUntilUnusable(t *testing.T) {
	p := newTwoNodePool(t, StrategySticky)
	ctx := context.Background()
	first, err := p.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		again, err := p.Take(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if again.Label() != first.Label() {
			t.Fatalf("sticky changed node: %s -> %s", first.Label(), again.Label())
		}
	}
	// 标记当前节点不可用，下一次必须换。
	p.Report(first, http.StatusBadGateway)
	next, err := p.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if next.Label() == first.Label() {
		t.Fatalf("sticky did not switch after failure: %s", next.Label())
	}
}

func TestRoundRobinSwitchesEachTime(t *testing.T) {
	p := newTwoNodePool(t, StrategyRoundRobin)
	ctx := context.Background()
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		e, err := p.Take(ctx)
		if err != nil {
			t.Fatal(err)
		}
		seen[e.Label()] = true
	}
	if len(seen) != 2 {
		t.Fatalf("round_robin used %d distinct nodes, want 2: %v", len(seen), seen)
	}
}

func TestNodesFilterByState(t *testing.T) {
	p := newTwoNodePool(t, StrategySticky)
	ctx := context.Background()
	first, err := p.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p.Report(first, http.StatusOK)
	healthy := p.Nodes("healthy")
	if len(healthy) != 1 || healthy[0].Label != first.Label() {
		t.Fatalf("healthy nodes = %+v, want only %s", healthy, first.Label())
	}
	if all := p.Nodes("all"); len(all) != 2 {
		t.Fatalf("all nodes = %d, want 2", len(all))
	}
	if p.Strategy() != string(StrategySticky) {
		t.Fatalf("strategy = %s", p.Strategy())
	}
}

func TestRefreshSwapsNodesAndPreservesState(t *testing.T) {
	var mu sync.Mutex
	body := "http://1.1.1.1:8080\nhttp://2.2.2.2:8080\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	p := New(srv.URL, 0, 0, StrategySticky)
	p.skipProbe = true
	ctx := context.Background()

	first, err := p.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 换到第二个节点并标健康。
	p.Report(first, http.StatusInternalServerError)
	second, err := p.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Label() == first.Label() {
		t.Fatalf("expected to switch away from cooled node")
	}
	p.Report(second, http.StatusOK)

	// 新订阅：删掉 first，保留 second，新增 third。
	mu.Lock()
	body = "http://2.2.2.2:8080\nhttp://3.3.3.3:8080\n"
	mu.Unlock()
	p.refreshSubscription(ctx)

	if p.Size() != 2 {
		t.Fatalf("size after refresh = %d, want 2", p.Size())
	}
	healthy := p.Nodes("healthy")
	if len(healthy) != 1 || healthy[0].Label != second.Label() {
		t.Fatalf("preserved healthy = %+v, want %s", healthy, second.Label())
	}
	for _, node := range p.Nodes("all") {
		if node.Label == first.Label() {
			t.Fatalf("removed node %s still present", first.Label())
		}
	}
}

func TestRefreshFailureKeepsExistingNodes(t *testing.T) {
	var mu sync.Mutex
	fail := false
	body := "http://1.1.1.1:8080\nhttp://2.2.2.2:8080\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	p := New(srv.URL, 0, 0, StrategySticky)
	p.skipProbe = true
	ctx := context.Background()
	if _, err := p.Take(ctx); err != nil {
		t.Fatal(err)
	}
	before := p.Size()

	mu.Lock()
	fail = true
	mu.Unlock()
	p.refreshSubscription(ctx)
	if p.Size() != before {
		t.Fatalf("failed refresh changed size: %d -> %d", before, p.Size())
	}

	mu.Lock()
	fail = false
	body = "vmess://unsupported\n"
	mu.Unlock()
	p.refreshSubscription(ctx)
	if p.Size() != before {
		t.Fatalf("empty refresh changed size: %d -> %d", before, p.Size())
	}
}
