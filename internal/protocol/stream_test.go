package protocol

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"oc2api/internal/shape"
)

func sseResponse(chunks ...string) *http.Response {
	body := strings.Join(chunks, "")
	return &http.Response{
		StatusCode: 200,
		Body:       io_NopCloser{strings.NewReader(body)},
	}
}

type io_NopCloser struct{ *strings.Reader }

func (io_NopCloser) Close() error { return nil }

func TestAggregateDropsBuiltinToolCalls(t *testing.T) {
	chunks := []string{
		`data: {"id":"c1","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\"path\":\"a\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	result, dropped, err := Aggregate(sseResponse(chunks...), shape.EmptyRenames())
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 1 {
		t.Fatalf("应丢弃 1 条内置工具调用，实际 %d", dropped)
	}
	choice := result["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if _, ok := message["tool_calls"]; ok {
		t.Fatal("内置工具调用不应透给客户端")
	}
	if choice["finish_reason"] != "stop" {
		t.Fatalf("finish_reason 应回退成 stop: %v", choice["finish_reason"])
	}
	_ = json.Marshal
}

func TestStreamDropsBuiltinToolCallsAndRewritesFinish(t *testing.T) {
	chunks := []string{
		`data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\"path\":\"a\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	var buffer strings.Builder
	if err := Stream(&stringWriter{&buffer}, sseResponse(chunks...), shape.EmptyRenames()); err != nil {
		t.Fatal(err)
	}
	output := buffer.String()
	if strings.Contains(output, `"tool_calls"`) {
		t.Fatalf("内置工具调用不应透给客户端: %s", output)
	}
	if !strings.Contains(output, `"finish_reason":"stop"`) {
		t.Fatalf("被丢光后 finish_reason 应回退成 stop: %s", output)
	}
}

type stringWriter struct{ builder *strings.Builder }

func (w *stringWriter) Write(p []byte) (int, error) { return w.builder.Write(p) }

func TestStreamKeepsUnknownToolCalls(t *testing.T) {
	chunks := []string{
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_command","arguments":"{\"command\":\"ls\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	var buffer strings.Builder
	if err := Stream(&stringWriter{&buffer}, sseResponse(chunks...), shape.EmptyRenames()); err != nil {
		t.Fatal(err)
	}
	output := buffer.String()
	if !strings.Contains(output, `"run_command"`) {
		t.Fatalf("非内置的工具调用必须放行: %s", output)
	}
	if !strings.Contains(output, `"finish_reason":"tool_calls"`) {
		t.Fatalf("放行时 finish_reason 应保持 tool_calls: %s", output)
	}
}
