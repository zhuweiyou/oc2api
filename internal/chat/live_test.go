package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"oc2api/internal/config"
	"oc2api/internal/protocol"
	"oc2api/internal/zen"
)

// 改动后的冒烟测试：一次流式 + 自定义工具的请求，再来一轮同会话的追问，
// 两次都拿到 200 且流里有正文与 [DONE] 即通过。
//
//	go test ./internal/chat -run TestLiveStreamWithToolThenFollowUp -v
//
// 需要真实上游额度，默认跳过；设置 OC2API_LIVE_TEST=1 才跑。
func TestLiveStreamWithToolThenFollowUp(t *testing.T) {
	if os.Getenv("OC2API_LIVE_TEST") != "1" {
		t.Skip("需要真实上游额度：OC2API_LIVE_TEST=1 go test ./internal/chat -run Live -v")
	}

	const model = "deepseek-v4.1-flash-free"
	session := zen.SessionID()
	service := newLiveService(t)

	weather := map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        "get_weather",
			"description": "查询城市天气",
			"parameters":  map[string]any{"type": "object", "properties": map[string]any{"city": map[string]any{"type": "string"}}, "required": []any{"city"}},
		},
	}

	first := map[string]any{
		"model":    model,
		"messages": []any{map[string]any{"role": "user", "content": "用 get_weather 查一下北京天气，然后告诉我。"}},
		"tools":    []any{weather},
	}
	text := streamOnce(t, service, model, session, first, 150*time.Second)

	second := map[string]any{
		"model": model,
		"messages": []any{
			map[string]any{"role": "user", "content": "用 get_weather 查一下北京天气，然后告诉我。"},
			map[string]any{"role": "assistant", "content": text},
			map[string]any{"role": "user", "content": "把城市换成上海。"},
		},
		"tools": []any{weather},
	}
	streamOnce(t, service, model, session, second, 150*time.Second)
}

// newLiveService 用真实环境变量组装对话服务（默认上游、默认超时）。
func newLiveService(t *testing.T) *Service {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("读取配置失败: %v", err)
	}
	return New(cfg, zen.New(cfg), nil)
}

// streamOnce 发一次流式请求，返回正文（可能为空），并断言流里有 [DONE]。
func streamOnce(t *testing.T, service *Service, model, session string, payload map[string]any, timeout time.Duration) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	resp, renames, err := service.UpstreamWithSession(ctx, payload, model, session)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		t.Fatalf("期望 200，实际 %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var buffer bytes.Buffer
	if err := protocol.Stream(&buffer, resp, renames); err != nil {
		t.Fatalf("读取流失败: %v", err)
	}
	output := buffer.String()
	if !strings.Contains(output, "data: ") {
		t.Fatalf("流里没有 SSE 帧: %q", output)
	}
	if !strings.Contains(output, "data: [DONE]") {
		t.Fatalf("流没有正常结束: %q", tail(output, 200))
	}
	return contentText(output)
}

func contentText(stream string) string {
	var builder strings.Builder
	for _, line := range strings.Split(stream, "\n") {
		if !strings.HasPrefix(line, "data: {") {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &chunk); err != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			builder.WriteString(choice.Delta.Content)
		}
	}
	return builder.String()
}

func tail(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[len(text)-n:]
}
