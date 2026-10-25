package shape

import (
	"encoding/json"
	"strings"
	"testing"
)

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
		if strings.HasPrefix(fn["name"].(string), "oc2api_") {
			continue
		}
		if fn["description"] != reservedToolDescription {
			t.Fatalf("内置工具 %s 的描述没有改成禁止调用", fn["name"])
		}
	}
	if !contains(names, "oc2api_get_weather") {
		t.Fatalf("客户端工具没有改名: %v", names)
	}
	if renames.Restore("oc2api_get_weather") != "get_weather" {
		t.Fatal("工具名还原失败")
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
