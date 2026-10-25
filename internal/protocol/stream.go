// Package protocol 解析上游 SSE，并把结果还原成面向客户端的帧/聚合对象。
package protocol

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"oc2api/internal/shape"
)

// Stream 逐帧转发上游 SSE：把 oc2api_ 前缀的工具名还原成客户端声明的名字，
// 同时丢掉上游自己选中、但客户端没声明的内置工具调用（客户端无法执行它们）。
func Stream(w io.Writer, upstream *http.Response, renames *shape.Renames) error {
	writer := bufio.NewWriter(w)
	defer func() { _ = writer.Flush() }()

	state := &streamState{decisions: map[int]bool{}} // true=保留, false=丢弃
	var buffered []string
	flushBuffered := func() error {
		for _, raw := range buffered {
			if text, ok := rewriteChunk(raw, renames, state, true); ok {
				if _, err := writer.WriteString("data: " + text + "\n\n"); err != nil {
					return err
				}
			}
		}
		buffered = nil
		return writer.Flush()
	}

	err := scanSSE(upstream.Body, func(data string) error {
		if data == "[DONE]" {
			buffered = nil // 名字始终没到的调用一律丢弃
			if _, err := writer.WriteString("data: [DONE]\n\n"); err != nil {
				return err
			}
			return writer.Flush()
		}

		decided, undecided := classifyChunk(data, renames, state.decisions)
		if undecided > 0 {
			// 名字还没到：先压住整帧，等定夺后一起放。
			buffered = append(buffered, data)
			return nil
		}
		_ = decided
		if len(buffered) > 0 {
			if err := flushBuffered(); err != nil {
				return err
			}
		}
		text, ok := rewriteChunk(data, renames, state, false)
		if !ok {
			return nil
		}
		if _, err := writer.WriteString("data: " + text + "\n\n"); err != nil {
			return err
		}
		return writer.Flush()
	})
	return err
}

// pendingCall 暂存一条工具调用的分块，直到拿到名字再决定去留。
type pendingCall struct {
	id    string
	name  string
	args  strings.Builder
	keep  bool
	named bool
}

func (p *pendingCall) observe(call map[string]any, renames *shape.Renames) {
	if value, ok := call["id"].(string); ok && value != "" && p.id == "" {
		p.id = value
	}
	fn, _ := call["function"].(map[string]any)
	if fn == nil {
		return
	}
	if name, _ := fn["name"].(string); name != "" && !p.named {
		p.named = true
		p.keep = renames.IsRenamed(name)
		if p.keep {
			p.name = renames.Restore(name)
		}
	}
	if args, ok := fn["arguments"].(string); ok {
		p.args.WriteString(args)
	}
}

// classifyChunk 记录本帧里出现的工具名，返回本帧是否已全部定夺。
func classifyChunk(data string, renames *shape.Renames, decisions map[int]bool) (decided int, undecided int) {
	var chunk map[string]any
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return 0, 0
	}
	choices, _ := chunk["choices"].([]any)
	for _, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, item := range calls {
			call, ok := item.(map[string]any)
			if !ok {
				continue
			}
			index := 0
			if value, ok := call["index"].(float64); ok {
				index = int(value)
			}
			if _, known := decisions[index]; known {
				continue
			}
			fn, _ := call["function"].(map[string]any)
			name := ""
			if fn != nil {
				name, _ = fn["name"].(string)
			}
			if name == "" {
				undecided++
				continue
			}
			decisions[index] = !dropToolCall(name, renames)
			decided++
		}
	}
	return decided, undecided
}

// Aggregate 把 SSE 聚合为非流式响应，同样丢掉客户端没有声明的工具调用。
func Aggregate(upstream *http.Response, renames *shape.Renames) (map[string]any, int, error) {
	var (
		id      string
		created float64
		model   string
		content strings.Builder
		reason  strings.Builder
		pending = map[int]*pendingCall{}
		finish  string
		usage   any
	)

	err := scanSSE(upstream.Body, func(data string) error {
		if data == "[DONE]" {
			return nil
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil
		}
		if value, ok := chunk["id"].(string); ok && id == "" {
			id = value
		}
		if value, ok := chunk["created"].(float64); ok && created == 0 {
			created = value
		}
		if value, ok := chunk["model"].(string); ok && model == "" {
			model = value
		}
		if value, ok := chunk["usage"]; ok && value != nil {
			usage = value
		}
		choices, _ := chunk["choices"].([]any)
		for _, raw := range choices {
			choice, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if value, ok := choice["finish_reason"].(string); ok && value != "" {
				finish = value
			}
			delta, _ := choice["delta"].(map[string]any)
			if delta == nil {
				continue
			}
			if text, ok := delta["content"].(string); ok {
				content.WriteString(text)
			}
			for _, key := range []string{"reasoning", "reasoning_content"} {
				if text, ok := delta[key].(string); ok {
					reason.WriteString(text)
				}
			}
			rawCalls, _ := delta["tool_calls"].([]any)
			for _, item := range rawCalls {
				call, ok := item.(map[string]any)
				if !ok {
					continue
				}
				index := 0
				if value, ok := call["index"].(float64); ok {
					index = int(value)
				}
				state := pending[index]
				if state == nil {
					state = &pendingCall{}
					pending[index] = state
				}
				state.observe(call, renames)
			}
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	dropped := 0
	for _, state := range pending {
		if !state.keep {
			dropped++
		}
	}

	message := map[string]any{"role": "assistant", "content": content.String()}
	if reason.Len() > 0 {
		message["reasoning_content"] = reason.String()
	}

	indexes := make([]int, 0, len(pending))
	for index, state := range pending {
		if state.keep {
			indexes = append(indexes, index)
		}
	}
	sort.Ints(indexes)
	if len(indexes) > 0 {
		toolCalls := make([]any, 0, len(indexes))
		for _, index := range indexes {
			state := pending[index]
			toolCalls = append(toolCalls, map[string]any{
				"id":   state.id,
				"type": "function",
				"function": map[string]any{
					"name":      state.name,
					"arguments": state.args.String(),
				},
			})
		}
		message["tool_calls"] = toolCalls
		if finish == "" {
			finish = "tool_calls"
		}
	} else if finish == "tool_calls" {
		// 内置工具调用全被丢掉时，别让客户端以为还有工具要执行。
		finish = "stop"
	}
	if finish == "" {
		finish = "stop"
	}
	if id == "" {
		id = "chatcmpl-oc2api"
	}
	result := map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": int64(created),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
	}
	if usage != nil {
		result["usage"] = usage
	}
	return result, dropped, nil
}

func scanSSE(body io.Reader, fn func(data string) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if err := fn(data); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// rewriteChunk 改写一帧：还原客户端工具名、丢掉内置工具调用。
// buffered=true 表示这一帧来自缓冲区，未知名字一律丢弃。
func rewriteChunk(data string, renames *shape.Renames, state *streamState, buffered bool) (string, bool) {
	var chunk map[string]any
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return data, true
	}
	choices, _ := chunk["choices"].([]any)
	for _, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		if len(calls) == 0 {
			continue
		}
		kept := make([]any, 0, len(calls))
		for _, item := range calls {
			call, ok := item.(map[string]any)
			if !ok {
				continue
			}
			index := 0
			if value, ok := call["index"].(float64); ok {
				index = int(value)
			}
			keep, known := state.decisions[index]
			if !known {
				if buffered {
					continue
				}
				keep = false
			}
			if !keep {
				continue
			}
			if fn, ok := call["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok && name != "" {
					fn["name"] = renames.Restore(name)
				}
			}
			kept = append(kept, call)
			state.kept = true
		}
		if len(kept) == 0 {
			delete(delta, "tool_calls")
		} else {
			delta["tool_calls"] = kept
		}
	}
	// 上游说这一轮以 tool_calls 结束，但所有调用都被我们丢掉了：
	// 必须改成 stop，否则客户端会等一个永远不会到来的工具执行。
	if finish, _ := choiceFinish(chunk); finish == "tool_calls" && !state.kept {
		setFinish(chunk, "stop")
	}
	encoded, err := json.Marshal(chunk)
	if err != nil {
		return data, true
	}
	return string(encoded), true
}

type streamState struct {
	decisions map[int]bool
	kept      bool
}

// ErrorBody 把上游非 2xx 映射成 OpenAI 风格错误，与 Node 版语义一致。
func ErrorBody(status int, message string) map[string]any {
	text := strings.TrimSpace(message)
	if text == "" {
		text = "Upstream returned HTTP " + http.StatusText(status)
	}
	switch {
	case status == http.StatusTooManyRequests:
		return map[string]any{"error": map[string]any{
			"message": text + " (free model rate limit)", "type": "rate_limit_error", "code": "rate_limit_exceeded",
		}}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return map[string]any{"error": map[string]any{
			"message": text, "type": "authentication_error", "code": "upstream_auth_error",
		}}
	case status >= 400 && status < 500:
		return map[string]any{"error": map[string]any{
			"message": text, "type": "invalid_request_error", "code": "upstream_invalid_request",
		}}
	}
	return map[string]any{"error": map[string]any{
		"message": text, "type": "upstream_error", "code": "upstream_error",
	}}
}

// choiceFinish 返回首个 choice 的 finish_reason。
func choiceFinish(chunk map[string]any) (string, bool) {
	choices, _ := chunk["choices"].([]any)
	for _, raw := range choices {
		if choice, ok := raw.(map[string]any); ok {
			if finish, ok := choice["finish_reason"].(string); ok && finish != "" {
				return finish, true
			}
		}
	}
	return "", false
}

// setFinish 把 finish_reason 改写成指定值。
func setFinish(chunk map[string]any, value string) {
	choices, _ := chunk["choices"].([]any)
	for _, raw := range choices {
		if choice, ok := raw.(map[string]any); ok {
			choice["finish_reason"] = value
		}
	}
}

// dropToolCall 只丢“官方内置、且客户端没有同名工具”的调用。
// 其余一律放行：客户端声明的工具（oc2api_ 前缀）要还原，未知名字也不拦，
// 避免把合法调用误伤成空回答。
func dropToolCall(name string, renames *shape.Renames) bool {
	if name == "" {
		return false
	}
	if renames.IsRenamed(name) || renames.HasClientTool(name) {
		return false
	}
	return shape.OfficialTool(name)
}
