package shape

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func wireNameFor(name string) string {
	sum := sha256.Sum256([]byte(name))
	return ToolPrefix + hex.EncodeToString(sum[:])[:clientToolDigestLength]
}

func TestBuildShapesOfficialRequest(t *testing.T) {
	payload := map[string]any{
		"model": "deepseek-v4.1-flash-free",
		"messages": []any{
			map[string]any{"role": "system", "content": "be brief"},
			map[string]any{"role": "user", "content": "hi"},
		},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "get_weather", "parameters": map[string]any{"type": "object"},
		}}},
	}
	body, renames, err := Build(payload, "deepseek-v4.1-flash-free")
	if err != nil {
		t.Fatal(err)
	}
	var shaped map[string]any
	if err := json.Unmarshal(body, &shaped); err != nil {
		t.Fatal(err)
	}
	if shaped["stream"] != true {
		t.Fatalf("上游只接受流式，stream 必须是 true: %v", shaped["stream"])
	}
	if shaped["max_completion_tokens"] != float64(32000) {
		t.Fatalf("缺少 32k 输出上限: %v", shaped["max_completion_tokens"])
	}
	messages := shaped["messages"].([]any)
	system := messages[0].(map[string]any)
	if system["role"] != "system" {
		t.Fatalf("首条必须是 system: %v", system["role"])
	}
	text := system["content"].(string)
	for _, want := range []string{"deepseek-v4.1-flash-free", "be brief", "<env>"} {
		if !strings.Contains(text, want) {
			t.Fatalf("system 缺少 %q", want)
		}
	}
	if strings.Contains(text, "{{") {
		t.Fatal("模板占位符没有被替换")
	}

	tools := shaped["tools"].([]any)
	names := make([]string, 0, len(tools))
	for _, raw := range tools {
		fn := raw.(map[string]any)["function"].(map[string]any)
		names = append(names, fn["name"].(string))
	}
	// 官方工具集整套发出去（形状校验依赖这一点），但描述统一换成“禁止调用”。
	for _, want := range []string{"edit", "patch", "read", "write", "shell"} {
		if !contains(names, want) {
			t.Fatalf("内置工具集缺少 %q: %v", want, names)
		}
	}
	for _, raw := range tools {
		fn := raw.(map[string]any)["function"].(map[string]any)
		name := fn["name"].(string)
		if strings.HasPrefix(name, ToolPrefix) {
			continue
		}
		if fn["description"] != reservedToolDescription {
			t.Fatalf("内置工具 %s 的描述没有换成禁止调用", name)
		}
	}
	// 客户端工具名必须摘要化，原始名字一个字符都不能出现在请求体里。
	wantWire := wireNameFor("get_weather")
	if !contains(names, wantWire) {
		t.Fatalf("客户端工具没有按摘要改名，期望 %q，实际 %v", wantWire, names)
	}
	if contains(names, "oc2api_get_weather") {
		t.Fatalf("客户端原始工具名被原样发往上游: %v", names)
	}
	if strings.Contains(string(body), "get_weather") {
		t.Fatal("请求体里不应出现客户端的原始工具名")
	}
	if renames.Restore(wantWire) != "get_weather" {
		t.Fatal("工具名还原失败")
	}
}

func TestBuildForwardsParamsWithoutHTMLEscape(t *testing.T) {
	payload := map[string]any{
		"model":       "deepseek-v4.1-flash-free",
		"messages":    []any{map[string]any{"role": "user", "content": "hi"}},
		"temperature": 0.3,
		"top_p":       0.9,
		"max_tokens":  512,
		"tool_choice": map[string]any{"type": "function", "function": map[string]any{"name": "get_weather"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name":        "get_weather",
			"description": "fetch <weather> & wind",
			"parameters":  map[string]any{"type": "object"},
		}}},
	}
	body, _, err := Build(payload, "deepseek-v4.1-flash-free")
	if err != nil {
		t.Fatal(err)
	}
	var shaped map[string]any
	if err := json.Unmarshal(body, &shaped); err != nil {
		t.Fatal(err)
	}
	if shaped["temperature"] != 0.3 {
		t.Fatalf("temperature 没有透传: %v", shaped["temperature"])
	}
	if shaped["top_p"] != 0.9 {
		t.Fatalf("top_p 没有透传: %v", shaped["top_p"])
	}
	// 显式 max_tokens 应作为输出上限，而不是被强行改成 32000。
	if shaped["max_completion_tokens"] != float64(512) {
		t.Fatalf("显式 max_tokens 没有被尊重: %v", shaped["max_completion_tokens"])
	}
	// 不能出现 HTML 转义，否则请求体字节和真实客户端不同。
	if strings.Contains(string(body), `\u003c`) || strings.Contains(string(body), `\u0026`) {
		t.Fatalf("body 里出现了 HTML 转义: %s", body)
	}
	// tool_choice 里引用的工具名也要摘要化，且不能是原始名字。
	choice := shaped["tool_choice"].(map[string]any)["function"].(map[string]any)
	name := choice["name"].(string)
	if !strings.HasPrefix(name, ToolPrefix) || name == "oc2api_get_weather" {
		t.Fatalf("tool_choice 的工具名没有摘要化: %q", name)
	}
}

// 非流式空回答会用同一份 payload 重试一次，Build 必须幂等且不改客户端 payload，
// 否则 tool_choice 里的名字会被二次哈希。
func TestBuildIsIdempotentAcrossRetries(t *testing.T) {
	payload := map[string]any{
		"model":       "deepseek-v4.1-flash-free",
		"messages":    []any{map[string]any{"role": "user", "content": "hi"}},
		"tool_choice": map[string]any{"type": "function", "function": map[string]any{"name": "get_weather"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "get_weather", "parameters": map[string]any{"type": "object"},
		}}},
	}
	first, _, err := Build(payload, "deepseek-v4.1-flash-free")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := Build(payload, "deepseek-v4.1-flash-free")
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("两次 Build 结果不一致（重试会二次改名）:\n%s\n%s", first, second)
	}
	original := payload["tool_choice"].(map[string]any)["function"].(map[string]any)["name"].(string)
	if original != "get_weather" {
		t.Fatalf("Build 改动了客户端 payload 的 tool_choice: %q", original)
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
