package zen

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"oc2api/internal/config"
)

// project id 必须是官方同款的 40 位十六进制，而且每请求不同：
// 固定值会让所有部署共用一个免费层配额桶（热门出口被打爆后本机也 429）。
func TestRandomProjectIDShape(t *testing.T) {
	first := randomProjectID()
	second := randomProjectID()
	for _, id := range []string{first, second} {
		if len(id) != 40 {
			t.Fatalf("project id 长度应为 40，实际 %d: %q", len(id), id)
		}
		if _, err := hex.DecodeString(id); err != nil {
			t.Fatalf("project id 不是十六进制: %q (%v)", id, err)
		}
	}
	if first == second {
		t.Fatal("project id 每次都一样，说明还是固定值")
	}
}

// v2 请求不要自己带 Accept：抓包的真实客户端没有这个头。
func TestUpstreamHeadersOmitAccept(t *testing.T) {
	headers := UpstreamHeaders("ses_x")
	if _, ok := headers["Accept"]; ok {
		t.Fatal("请求头不应自己设置 Accept")
	}
	if headers["x-opencode-project"] == "" {
		t.Fatal("缺少 x-opencode-project")
	}
}

// 基址只到站点根，路径由包内常量拼：上游换路径只改常量，这里守住拼接结果。
func TestURLJoining(t *testing.T) {
	client := New(config.Config{ZenAPIBaseURL: "https://opencode.ai", ZenConnectTimeout: time.Second})
	if client.modelsURL != "https://opencode.ai/inference/v1/models" {
		t.Errorf("modelsURL = %q", client.modelsURL)
	}
	if client.chatURL != "https://opencode.ai/inference/v1/chat/completions" {
		t.Errorf("chatURL = %q", client.chatURL)
	}
}

// 自建中继只填站点根（可能带反代前缀），拼接时不能重复或丢失前缀路径。
func TestURLJoiningWithProxyPrefix(t *testing.T) {
	client := New(config.Config{ZenAPIBaseURL: "http://relay.local/oc2api", ZenConnectTimeout: time.Second})
	if client.modelsURL != "http://relay.local/oc2api/inference/v1/models" {
		t.Errorf("modelsURL = %q", client.modelsURL)
	}
}

// 上游接了连接却迟迟不给响应头时，必须在 ZEN_CONNECT_TIMEOUT_MS 内放弃，
// 而不是挂到平台上限。这里用“永不回包”的本地上游验证超时真的接上了。
func TestModelsTimesOutBeforeHeaders(t *testing.T) {
	for _, timeout := range []time.Duration{150 * time.Millisecond, 600 * time.Millisecond} {
		t.Run(timeout.String(), func(t *testing.T) {
			release := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				<-release
			}))
			defer func() {
				close(release)
				upstream.Close()
			}()

			client := New(config.Config{ZenAPIBaseURL: upstream.URL, ZenConnectTimeout: timeout})

			started := time.Now()
			_, err := client.Models(context.Background())
			elapsed := time.Since(started)

			if err == nil {
				t.Fatal("上游不回响应头时应该超时失败")
			}
			if elapsed < timeout*9/10 {
				t.Errorf("耗时 %v 早于超时 %v，说明客户端不是被超时打断的", elapsed, timeout)
			}
			// 上限放宽到 3 倍 + 200ms，避免 CI 上偶发的调度抖动把测试打成假失败。
			if elapsed > timeout*3+200*time.Millisecond {
				t.Errorf("耗时 %v 远超超时 %v，说明超时没接上", elapsed, timeout)
			}
		})
	}
}
