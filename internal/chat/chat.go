// Package chat 串起一次对话请求：整形 → 上游 → 原始响应交给调用方。
package chat

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"oc2api/internal/config"
	"oc2api/internal/protocol"
	"oc2api/internal/proxypool"
	"oc2api/internal/shape"
	"oc2api/internal/zen"
)

// Service 持有一次对话需要的依赖，由 main 注入。
type Service struct {
	client   *zen.Client
	proxies  *proxypool.Pool
	attempts int
	debug    bool
}

// New 注入上游客户端、代理池与调试开关。proxies 为 nil 时保持直连。
func New(cfg config.Config, client *zen.Client, proxies *proxypool.Pool) *Service {
	attempts := cfg.ProxyMaxAttempts
	if attempts < 1 {
		attempts = 1
	}
	return &Service{client: client, proxies: proxies, attempts: attempts, debug: cfg.Debug}
}

// Upstream 发起一次上游对话请求（上游只接受流式，非流式由调用方聚合）。
func (s *Service) Upstream(ctx context.Context, payload map[string]any, model string) (*http.Response, *shape.Renames, error) {
	return s.UpstreamWithSession(ctx, payload, model, zen.SessionID())
}

// UpstreamWithSession 允许复用会话 id，多轮对话可以命中上游 prompt 缓存。
func (s *Service) UpstreamWithSession(ctx context.Context, payload map[string]any, model, session string) (*http.Response, *shape.Renames, error) {
	body, renames, err := shape.Build(payload, model)
	if err != nil {
		return nil, nil, err
	}
	if s.debug {
		log.Printf("[chat] model=%s session=%s%s tools=%d body=%dB", model, session, describeMessages(payload), countClientTools(payload), len(body))
	}
	if s.proxies == nil {
		return s.chatOnce(ctx, s.client, body, session, renames)
	}

	// 订阅代理模式：每次尝试取一个出口；429/403/5xx 就换下一个，最多 attempts 个。
	var lastErr error
	for i := 0; i < s.attempts; i++ {
		entry, err := s.proxies.Take(ctx)
		if err != nil {
			// 订阅拉取失败不应让服务直接不可用：记录后退回直连。
			if s.debug {
				log.Printf("[chat] 代理池不可用（%v），本次退回直连", err)
			}
			return s.chatOnce(ctx, s.client, body, session, renames)
		}
		resp, err := s.client.WithDial(entry.Dial).Chat(ctx, body, session)
		if err != nil {
			s.proxies.Report(entry, http.StatusBadGateway)
			lastErr = err
			if s.debug {
				log.Printf("[chat] proxy=%s attempt=%d 传输失败: %v", entry.Label(), i+1, err)
			}
			continue
		}
		if s.debug {
			log.Printf("[chat] proxy=%s attempt=%d upstream status=%d retry-after=%s",
				entry.Label(), i+1, resp.StatusCode, resp.Header.Get("Retry-After"))
		}
		if retryableProxyStatus(resp.StatusCode) && i+1 < s.attempts {
			s.proxies.Report(entry, resp.StatusCode)
			if s.debug {
				log.Printf("[chat] proxy=%s 返回 %d，换下一个出口", entry.Label(), resp.StatusCode)
			}
			drainAndClose(resp.Body)
			continue
		}
		s.proxies.Report(entry, resp.StatusCode)
		return resp, renames, nil
	}
	if lastErr == nil {
		lastErr = errors.New("所有代理出口尝试均失败")
	}
	return nil, nil, lastErr
}

// chatOnce 走注入客户端的原始直连逻辑。
func (s *Service) chatOnce(ctx context.Context, client *zen.Client, body []byte, session string, renames *shape.Renames) (*http.Response, *shape.Renames, error) {
	resp, err := client.Chat(ctx, body, session)
	if err != nil {
		return nil, nil, err
	}
	if s.debug {
		log.Printf("[chat] upstream status=%d retry-after=%s", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	return resp, renames, nil
}

// retryableProxyStatus 表示该状态码更像「这个出口的额度/网络问题」，值得换一个出口。
func retryableProxyStatus(status int) bool {
	return status == http.StatusForbidden || status == http.StatusTooManyRequests || status >= 500
}

// drainAndClose 丢弃响应体并关闭连接，避免换出口时泄漏连接。
func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.CopyN(io.Discard, body, 64<<10)
	_ = body.Close()
}

// describeMessages 汇总消息角色，便于在日志里还原客户端请求形态。
func describeMessages(payload map[string]any) string {
	messages, _ := payload["messages"].([]any)
	roles := make([]string, 0, len(messages))
	for _, raw := range messages {
		if message, ok := raw.(map[string]any); ok {
			role, _ := message["role"].(string)
			roles = append(roles, role)
		}
	}
	return " messages=" + strings.Join(roles, ",")
}

func countClientTools(payload map[string]any) int {
	tools, _ := payload["tools"].([]any)
	return len(tools)
}

// Validate 与 Node 版保持同一套门面校验：只拦明显不合法的请求，
// 其余字段原样交给上游。返回空字符串表示通过。
func Validate(payload map[string]any) (model string, reason string) {
	model, _ = payload["model"].(string)
	if strings.TrimSpace(model) == "" {
		return "", "model must be a non-empty string"
	}
	if model != "big-pickle" && !strings.HasSuffix(model, "-free") {
		return "", "Only big-pickle and models ending in -free are allowed"
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) == 0 {
		return "", "messages must be a non-empty array"
	}
	return model, ""
}

// 客户端没有工具时，模型偶尔仍会选中内置工具；被丢弃后正文为空，这时补一句
// 明确指令重试一次，避免给客户端一个空回答。
const noToolRetry = "（本客户端没有可用的工具，请直接用文字回答，不要调用任何工具。）"

// Complete 返回聚合后的非流式响应。
func (s *Service) Complete(ctx context.Context, payload map[string]any, model string) (map[string]any, error) {
	resp, renames, err := s.Upstream(ctx, payload, model)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, &UpstreamError{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After"), Body: text}
	}
	result, dropped, err := protocol.Aggregate(resp, renames)
	if err != nil {
		return nil, err
	}
	if dropped == 0 || hasContent(result) {
		return result, nil
	}

	retryPayload := withNudge(payload)
	resp2, renames2, err := s.Upstream(ctx, retryPayload, model)
	if err != nil {
		return result, nil
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		return result, nil
	}
	retried, _, err := protocol.Aggregate(resp2, renames2)
	if err != nil || !hasContent(retried) {
		return result, nil
	}
	return retried, nil
}

// UpstreamError 保留上游状态码，供 HTTP/RPC 层原样透出。
type UpstreamError struct {
	Status     int
	RetryAfter string
	Body       []byte
}

func (e *UpstreamError) Error() string { return string(e.Body) }

func hasContent(result map[string]any) bool {
	choices, _ := result["choices"].([]any)
	for _, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		message, _ := choice["message"].(map[string]any)
		if text, ok := message["content"].(string); ok && strings.TrimSpace(text) != "" {
			return true
		}
		if _, ok := message["tool_calls"]; ok {
			return true
		}
	}
	return false
}

func withNudge(payload map[string]any) map[string]any {
	cloned := map[string]any{}
	for k, v := range payload {
		cloned[k] = v
	}
	messages, _ := payload["messages"].([]any)
	extended := make([]any, 0, len(messages)+1)
	extended = append(extended, messages...)
	extended = append(extended, map[string]any{"role": "user", "content": noToolRetry})
	cloned["messages"] = extended
	return cloned
}
