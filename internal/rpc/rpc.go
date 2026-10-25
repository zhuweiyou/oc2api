// Package rpc 提供 JSON-RPC 2.0 传输层，供 Vercel 的薄 Node 层调用。
// 两种载体共用一套处理逻辑：HTTP（调试/兜底）与 stdio（Node spawn 的常驻二进制，
// 流式只有这条能走通，因为 Vercel 的 Go runtime 会缓冲整段响应）。
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"

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

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type emitter func(msg map[string]any)

func emitResult(emit emitter, id any, result any) {
	emit(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func emitError(emit emitter, id any, code int, message string) {
	emit(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
}

func emitNotify(emit emitter, id any, method string, params any) {
	emit(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

// Handle 处理一条 JSON-RPC 请求，把结果/通知交给 emit。
func Handle(ctx context.Context, raw []byte, emit emitter) {
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		emitError(emit, nil, -32700, "parse error")
		return
	}
	switch req.Method {
	case "health":
		emitResult(emit, req.ID, map[string]any{
			"status":    "ok",
			"version":   config.Version,
			"endpoints": endpointList,
		})
	case "models":
		list, err := zen.FetchModels(ctx)
		if err != nil {
			emitError(emit, req.ID, -32000, err.Error())
			return
		}
		emitResult(emit, req.ID, map[string]any{"object": "list", "data": list})
	case "ip":
		found, source := ipinfo.Lookup(&http.Client{})
		if found == "" {
			emitError(emit, req.ID, -32000, "all IP providers failed")
			return
		}
		emitResult(emit, req.ID, map[string]any{"ip": found, "source": source})
	case "chat":
		handleChat(ctx, req, emit)
	default:
		emitError(emit, req.ID, -32601, "method not found")
	}
}

type chatParams struct {
	Body   json.RawMessage `json:"body"`
	Stream bool            `json:"stream"`
}

func handleChat(ctx context.Context, req request, emit emitter) {
	var params chatParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		emitError(emit, req.ID, -32602, "invalid params")
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(params.Body, &payload); err != nil {
		emitError(emit, req.ID, -32602, "invalid body")
		return
	}
	model, reason := chat.Validate(payload)
	if reason != "" {
		emitResult(emit, req.ID, map[string]any{
			"status": http.StatusBadRequest,
			"error":  protocol.ErrorBody(http.StatusBadRequest, reason),
		})
		return
	}

	if !params.Stream {
		result, err := chat.Complete(ctx, payload, model)
		if err != nil {
			var upstream *chat.UpstreamError
			if errors.As(err, &upstream) {
				emitResult(emit, req.ID, map[string]any{
					"status":     upstream.Status,
					"retryAfter": upstream.RetryAfter,
					"error":      protocol.ErrorBody(upstream.Status, string(upstream.Body)),
				})
				return
			}
			emitError(emit, req.ID, -32000, err.Error())
			return
		}
		emitResult(emit, req.ID, result)
		return
	}

	resp, renames, err := chat.Upstream(ctx, payload, model)
	if err != nil {
		emitError(emit, req.ID, -32000, err.Error())
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		emitResult(emit, req.ID, map[string]any{
			"status":     resp.StatusCode,
			"retryAfter": resp.Header.Get("Retry-After"),
			"error":      protocol.ErrorBody(resp.StatusCode, string(text)),
		})
		return
	}

	if err := protocol.Stream(&emitWriter{emit: emit, id: req.ID}, resp, renames); err != nil {
		return
	}
	emitNotify(emit, req.ID, "end", map[string]any{})
}

// emitWriter 把 SSE 文本包成带 id 的通知，一帧一条。
type emitWriter struct {
	emit emitter
	id   any
}

func (e *emitWriter) Write(p []byte) (int, error) {
	emitNotify(e.emit, e.id, "sse", map[string]any{"data": string(p)})
	return len(p), nil
}

// ServeStdio 从 stdin 读 NDJSON 请求，逐条处理；每条一个 goroutine，
// 输出用互斥锁串行化，避免不同请求的消息交错。
func ServeStdio() error {
	encoder := json.NewEncoder(os.Stdout)
	var mu sync.Mutex
	emit := func(msg map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		_ = encoder.Encode(msg)
	}

	var wg sync.WaitGroup
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), maxBodyBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		raw := append([]byte(nil), line...)
		wg.Add(1)
		go func() {
			defer wg.Done()
			Handle(context.Background(), raw, emit)
		}()
	}
	wg.Wait()
	return scanner.Err()
}
