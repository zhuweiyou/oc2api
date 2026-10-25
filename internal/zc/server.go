package zc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
)

const maxBodyBytes = 32 << 20

// Config 汇总进程级配置，全部来自环境变量，和 Node 版保持同名。
type Config struct {
	APIKey string
	Debug  bool
}

func LoadConfig() Config {
	return Config{
		APIKey: strings.TrimSpace(os.Getenv("API_KEY")),
		Debug:  os.Getenv("DEBUG") == "true",
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any, headers map[string]string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOpenAIError(w http.ResponseWriter, status int, message, kind, code string, headers map[string]string) {
	payload := map[string]any{"error": map[string]any{"message": message, "type": kind}}
	if code != "" {
		payload["error"].(map[string]any)["code"] = code
	}
	writeJSON(w, status, payload, headers)
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

// Server 是本地与 Docker 使用的纯 Go 服务，端点与 Node 版一一对应。
func Server() http.Handler {
	cfg := LoadConfig()
	mux := http.NewServeMux()

	mux.HandleFunc("/", withCORS(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/health":
			writeJSON(w, http.StatusOK, map[string]any{
				"status":  "ok",
				"version": Version,
				"runtime": "go",
				"endpoints": []string{
					"/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip",
				},
			}, nil)
		case "/ip":
			handleIP(w, r)
		case "/v1/models", "/models":
			if !authorized(cfg, r) {
				writeOpenAIError(w, http.StatusUnauthorized, "Invalid API key", "authentication_error", "", nil)
				return
			}
			handleModels(w, r)
		case "/v1/chat/completions", "/chat/completions":
			if !authorized(cfg, r) {
				writeOpenAIError(w, http.StatusUnauthorized, "Invalid API key", "authentication_error", "", nil)
				return
			}
			handleChat(w, r)
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"message": "Not found", "type": "invalid_request_error"}}, nil)
		}
	}))

	return mux
}

func authorized(cfg Config, r *http.Request) bool {
	if cfg.APIKey == "" {
		return true
	}
	header := r.Header.Get("Authorization")
	if strings.HasPrefix(header, "Bearer ") && strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")) == cfg.APIKey {
		return true
	}
	return strings.TrimSpace(r.Header.Get("X-API-Key")) == cfg.APIKey
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	models, err := FetchModels(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": models}, nil)
}

func handleIP(w http.ResponseWriter, _ *http.Request) {
	res, err := http.Get("https://api.ipquery.io")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error", nil)
		return
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(string(body)), "source": "https://api.ipquery.io"}, nil)
}

// Chat 发一次上游请求，返回原始响应供调用方决定流式还是聚合。
func Chat(ctx context.Context, payload map[string]any, model string, stream bool) (*http.Response, *Renames, error) {
	shaped, renames, err := Build(payload, model, stream)
	if err != nil {
		return nil, nil, err
	}
	resp, err := Post(ctx, "/openai/v1/chat/completions", shaped, SessionID())
	if err != nil {
		return nil, nil, err
	}
	return resp, renames, nil
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "Method not allowed", "invalid_request_error", "", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "Invalid JSON body", "invalid_request_error", "", nil)
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "Invalid JSON body", "invalid_request_error", "", nil)
		return
	}
	model, _ := payload["model"].(string)
	if strings.TrimSpace(model) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model must be a non-empty string", "invalid_request_error", "", nil)
		return
	}
	if model != "big-pickle" && !strings.HasSuffix(model, "-free") {
		writeOpenAIError(w, http.StatusBadRequest, "Only big-pickle and models ending in -free are allowed", "invalid_request_error", "", nil)
		return
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "messages must be a non-empty array", "invalid_request_error", "", nil)
		return
	}
	stream, _ := payload["stream"].(bool)

	resp, renames, err := Chat(r.Context(), payload, model, stream)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream error: "+err.Error(), "upstream_error", "upstream_error", nil)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		headers := map[string]string{}
		if retry := resp.Header.Get("Retry-After"); retry != "" {
			headers["Retry-After"] = retry
		}
		writeJSON(w, resp.StatusCode, ErrorBody(resp.StatusCode, string(text)), headers)
		return
	}

	if stream {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_ = Stream(w, resp, renames)
		return
	}

	result, err := Aggregate(resp, renames)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "Upstream stream error: "+err.Error(), "upstream_error", "upstream_stream_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, result, nil)
}
