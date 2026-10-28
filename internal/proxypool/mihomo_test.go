//go:build !nomihomo

package proxypool

import "testing"

func TestParseClashNodes(t *testing.T) {
	body := []byte(`proxies:
  - name: a
    type: ss
    cipher: aes-256-gcm
    password: pass
    server: 127.0.0.1
    port: 1234
  - name: chained
    type: socks5
    server: 127.0.0.1
    port: 1080
    username: u
    password: p
    dialer-proxy: relay
`)
	nodes, skipped := ParseSubscription(body)
	if len(nodes) != 1 {
		t.Fatalf("nodes = %d, want 1 (chained node should be skipped)", len(nodes))
	}
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1", skipped)
	}
	if nodes[0].Label() != "ss:a" {
		t.Fatalf("label = %q, want ss:a", nodes[0].Label())
	}
}

func TestKernelAvailable(t *testing.T) {
	if !KernelAvailable() {
		t.Fatal("kernel should be available in default build")
	}
}
