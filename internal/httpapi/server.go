// Package httpapi 是本地与 Docker 的 HTTP 入口，端点与 Node 版保持一致。
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"oc2api/internal/chat"
	"oc2api/internal/config"
	"oc2api/internal/ipinfo"
	"oc2api/internal/protocol"
	"oc2api/internal/zen"
)

const maxBodyBytes = 32 << 20

var endpointList = []string{
	"/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip",
}

func writeJSON(w http.ResponseWriter, status int, payload any, headers map[string]string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOpenAIError(w http.ResponseWriter, status int, message, kind, code string) {
	body := map[string]any{"message": message, "type": kind}
	if code != "" {
		body["code"] = code
	}
	writeJSON(w, status, map[string]any{"error": body}, nil)
}

// New 组装路由：/ 与 /health 公开，其余按 API_KEY 鉴权。
// 配置与上游客户端都由 main 注入，这里不再读环境变量。
func New(cfg config.Config, client *zen.Client, chats *chat.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", withCORS(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/health", "":
			health(w)
		case "/ip":
			ip(w)
		case "/v1/models", "/models":
			if !authorized(cfg, r) {
				writeOpenAIError(w, http.StatusUnauthorized, "Invalid API key", "authentication_error", "")
				return
			}
			models(w, r, client)
		case "/v1/chat/completions", "/chat/completions":
			if !authorized(cfg, r) {
				writeOpenAIError(w, http.StatusUnauthorized, "Invalid API key", "authentication_error", "")
				return
			}
			completions(w, r, chats)
		default:
			writeOpenAIError(w, http.StatusNotFound, "Not found", "invalid_request_error", "")
		}
	}))
	return mux
}

func health(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"version":   config.Version,
		"endpoints": endpointList,
	}, nil)
}

// authorized 与 Node 版 authenticate 等价：authorization 优先，回退 x-api-key；
// 带不带 "Bearer " 前缀都接受，比较的是去掉前缀后的原始 token。
func authorized(cfg config.Config, r *http.Request) bool {
	if cfg.APIKey == "" {
		return true
	}
	header := r.Header.Get("Authorization")
	if header == "" {
		header = r.Header.Get("X-API-Key")
	}
	token := strings.TrimSpace(header)
	if strings.HasPrefix(strings.ToLower(token), "bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	return token == cfg.APIKey
}

func models(w http.ResponseWriter, r *http.Request, client *zen.Client) {
	list, err := client.Models(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": list}, nil)
}

// ip 与 Node 版一致：依次尝试两个供应商，返回 {ip, source}。
func ip(w http.ResponseWriter) {
	found, source := ipinfo.Lookup(&http.Client{})
	if found == "" {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: all IP providers failed", "upstream_error", "upstream_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ip": found, "source": source}, nil)
}

func completions(w http.ResponseWriter, r *http.Request, chats *chat.Service) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "Not found", "invalid_request_error", "")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "Invalid JSON body", "invalid_request_error", "")
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "Invalid JSON body", "invalid_request_error", "")
		return
	}
	model, reason := chat.Validate(payload)
	if reason != "" {
		writeOpenAIError(w, http.StatusBadRequest, reason, "invalid_request_error", "")
		return
	}
	stream, _ := payload["stream"].(bool)

	if !stream {
		result, err := chats.Complete(r.Context(), payload, model)
		if err != nil {
			var upstream *chat.UpstreamError
			if errors.As(err, &upstream) {
				headers := map[string]string{}
				if upstream.RetryAfter != "" {
					headers["Retry-After"] = upstream.RetryAfter
				}
				writeJSON(w, upstream.Status, protocol.ErrorBody(upstream.Status, string(upstream.Body)), headers)
				return
			}
			writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error")
			return
		}
		writeJSON(w, http.StatusOK, result, nil)
		return
	}

	resp, renames, err := chats.Upstream(r.Context(), payload, model)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error")
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		headers := map[string]string{}
		if retry := resp.Header.Get("Retry-After"); retry != "" {
			headers["Retry-After"] = retry
		}
		writeJSON(w, resp.StatusCode, protocol.ErrorBody(resp.StatusCode, string(text)), headers)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	_ = protocol.Stream(w, resp, renames)
}

func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta")
		w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, Retry-After, Retry-After-Ms")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}
