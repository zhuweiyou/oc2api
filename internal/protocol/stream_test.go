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
