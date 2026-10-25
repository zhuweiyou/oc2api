package zc

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

// JSON-RPC 2.0 传输层。两种载体共用同一套处理逻辑：
//   - HTTP：Vercel 上的 Go 函数（也用于本地 -rpc 调试）；
//   - stdio：Vercel 上由 Node 薄层 spawn 的常驻二进制（流式只有这条能走通）。
//
// 流式请求把每一帧包成带同一个 id 的通知，Node 侧按 id 归位：
//   {"jsonrpc":"2.0","id":1,"method":"sse","params":{"data":"data: {...}\n\n"}}
//   {"jsonrpc":"2.0","id":1,"method":"end"}
//   {"jsonrpc":"2.0","id":1,"method":"error","params":{"status":429,"retryAfter":"..."}}

type rpcRequest struct {
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

// HandleRPC 处理一条 JSON-RPC 请求，把结果/通知交给 emit。
func HandleRPC(ctx context.Context, raw []byte, emit emitter) {
	var request rpcRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		emitError(emit, nil, -32700, "parse error")
		return
	}

	switch request.Method {
	case "health":
		emitResult(emit, request.ID, map[string]any{"status": "ok", "version": Version, "runtime": "go"})
	case "models":
		models, err := FetchModels(ctx)
		if err != nil {
			emitError(emit, request.ID, -32000, err.Error())
			return
		}
		emitResult(emit, request.ID, map[string]any{"object": "list", "data": models})
	case "ip":
		emitResult(emit, request.ID, map[string]any{"ip": clientIP(ctx)})
	case "chat":
		handleRPChat(ctx, request, emit)
	default:
		emitError(emit, request.ID, -32601, "method not found")
	}
}

type chatParams struct {
	Body   json.RawMessage `json:"body"`
	Stream bool            `json:"stream"`
}

func handleRPChat(ctx context.Context, request rpcRequest, emit emitter) {
	var params chatParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		emitError(emit, request.ID, -32602, "invalid params")
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(params.Body, &payload); err != nil {
		emitError(emit, request.ID, -32602, "invalid body")
		return
	}
	model, _ := payload["model"].(string)
	if strings.TrimSpace(model) == "" {
		emitError(emit, request.ID, -32602, "model required")
		return
	}

	resp, renames, err := Chat(ctx, payload, model, params.Stream)
	if err != nil {
		emitError(emit, request.ID, -32000, err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		emitResult(emit, request.ID, map[string]any{
			"status":     resp.StatusCode,
			"retryAfter": resp.Header.Get("Retry-After"),
			"error":      ErrorBody(resp.StatusCode, string(text)),
		})
		return
	}

	if !params.Stream {
		result, err := Aggregate(resp, renames)
		if err != nil {
			emitError(emit, request.ID, -32000, err.Error())
			return
		}
		emitResult(emit, request.ID, result)
		return
	}

	writer := &emitWriter{emit: emit, id: request.ID}
	if err := Stream(writer, resp, renames); err != nil {
		return
	}
	emitNotify(emit, request.ID, "end", map[string]any{})
}

// emitWriter 把 SSE 文本包成通知，一帧一条。
type emitWriter struct {
	emit emitter
	id   any
}

func (e *emitWriter) Write(p []byte) (int, error) {
	emitNotify(e.emit, e.id, "sse", map[string]any{"data": string(p)})
	return len(p), nil
}

// ---- HTTP 载体 ----

func RPCHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		write := func(msg map[string]any) {
			payload, _ := json.Marshal(msg)
			_, _ = w.Write(append(payload, '\n'))
			if flusher != nil {
				flusher.Flush()
			}
		}
		HandleRPC(r.Context(), raw, write)
	})
}

// ---- stdio 载体（Vercel 常驻二进制）----

// StdioServe 从 stdin 读 NDJSON 请求，逐条处理；每条请求一个 goroutine，
// 输出用互斥锁串行化，保证一条消息不会和其它请求的消息交错。
func StdioServe() error {
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
			HandleRPC(context.Background(), raw, emit)
		}()
	}
	wg.Wait()
	return scanner.Err()
}

// clientIP 目前没有载体注入，保留方法名以便后续接真实出口。
func clientIP(context.Context) string { return "" }
