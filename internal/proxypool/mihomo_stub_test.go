//go:build nomihomo

package proxypool

import "testing"

func TestKernelUnavailable(t *testing.T) {
	if KernelAvailable() {
		t.Fatal("kernel must be unavailable in nomihomo build")
	}
}
