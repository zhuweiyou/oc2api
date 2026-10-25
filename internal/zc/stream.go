package zc

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
)

// 上游只支持 SSE；非流式请求在这里聚合成一条 chat.completion。
type toolCallState struct {
	ID        string
	Name      string
	Arguments strings.Builder
}

// Stream 逐帧转发上游 SSE，同时把 clint_ 工具名还原成客户端声明的名字。
func Stream(w io.Writer, upstream *http.Response, renames *Renames) error {
	writer := bufio.NewWriter(w)
	defer writer.Flush()

	err := scanSSE(upstream.Body, func(data string) error {
		if data == "[DONE]" {
			_, err := writer.WriteString("data: [DONE]\n\n")
			if err != nil {
				return err
			}
			return writer.Flush()
		}
		rewritten := rewriteToolNames(data, renames)
		if _, err := writer.WriteString("data: " + rewritten + "\n\n"); err != nil {
			return err
		}
		return writer.Flush()
	})
	return err
}

// Aggregate 把 SSE 聚合为非流式响应。
func Aggregate(upstream *http.Response, renames *Renames) (map[string]any, error) {
	var (
		id      string
		created float64
		model   string
		content strings.Builder
		reason  strings.Builder
		calls   = map[int]*toolCallState{}
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
				state := calls[index]
				if state == nil {
					state = &toolCallState{}
					calls[index] = state
				}
				if value, ok := call["id"].(string); ok && value != "" {
					state.ID = value
				}
				if fn, ok := call["function"].(map[string]any); ok {
					if value, ok := fn["name"].(string); ok && value != "" {
						state.Name = renames.Restore(value)
					}
					if value, ok := fn["arguments"].(string); ok {
						state.Arguments.WriteString(value)
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	message := map[string]any{"role": "assistant", "content": content.String()}
	if reason.Len() > 0 {
		message["reasoning_content"] = reason.String()
	}
	if len(calls) > 0 {
		indexes := make([]int, 0, len(calls))
		for index := range calls {
			indexes = append(indexes, index)
		}
		sort.Ints(indexes)
		toolCalls := make([]any, 0, len(indexes))
		for _, index := range indexes {
			state := calls[index]
			toolCalls = append(toolCalls, map[string]any{
				"id":   state.ID,
				"type": "function",
				"function": map[string]any{
					"name":      state.Name,
					"arguments": state.Arguments.String(),
				},
			})
		}
		message["tool_calls"] = toolCalls
		if finish == "" {
			finish = "tool_calls"
		}
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
	return result, nil
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

// rewriteToolNames 只改 name 字段，正文原样保留。
func rewriteToolNames(data string, renames *Renames) string {
	if renames == nil || !strings.Contains(data, clientPrefix) {
		return data
	}
	var chunk map[string]any
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return data
	}
	choices, _ := chunk["choices"].([]any)
	for _, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for _, holderKey := range []string{"delta", "message"} {
			holder, ok := choice[holderKey].(map[string]any)
			if !ok {
				continue
			}
			rewriteCalls(holder, renames)
		}
	}
	encoded, err := json.Marshal(chunk)
	if err != nil {
		return data
	}
	return string(encoded)
}

func rewriteCalls(holder map[string]any, renames *Renames) {
	calls, ok := holder["tool_calls"].([]any)
	if !ok {
		return
	}
	for _, raw := range calls {
		call, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := call["function"].(map[string]any)
		if !ok {
			continue
		}
		if name, ok := fn["name"].(string); ok && name != "" {
			fn["name"] = renames.Restore(name)
		}
	}
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
