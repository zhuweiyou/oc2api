package shape

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

//go:embed assets/prompt.txt
var promptTemplate string

//go:embed assets/tools.json
var toolsJSON []byte

const (
	// 免费层要求请求看起来像官方客户端：system 提示词 + 官方工具集 + 32k 输出上限。
	// ToolPrefix 是客户端工具发往上游时加的前缀；请求侧加、响应侧剥，都用它。
	ToolPrefix  = "oc2api_"
	outputLimit = 32000
)

// Renames 记录客户端工具名与发往上游的名字之间的双向映射。
type Renames struct {
	forward map[string]string // 客户端名 -> 上游名
	reverse map[string]string // 上游名 -> 客户端名
}

// HasClientTool 判断某个名字是不是客户端声明过的工具（原名）。
func (r *Renames) HasClientTool(name string) bool {
	if r == nil {
		return false
	}
	_, ok := r.forward[name]
	return ok
}

// OfficialTool 判断某个名字是不是我们发出去的官方内置工具（目前只有 read）。
func OfficialTool(name string) bool {
	for _, raw := range officialTools() {
		if tool, ok := raw.(map[string]any); ok {
			if fn, ok := tool["function"].(map[string]any); ok && fn["name"] == name {
				return true
			}
		}
	}
	return false
}

// EmptyRenames 返回一个没有任何映射的 Renames，便于测试与「无客户端工具」场景。
func EmptyRenames() *Renames { return newRenames() }

func newRenames() *Renames {
	return &Renames{forward: map[string]string{}, reverse: map[string]string{}}
}

var unsafeToolChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// rename 把客户端工具名换成 <ToolPrefix><sanitized>，并保证不与已用的名字冲突。
func (r *Renames) rename(name string) string {
	if name == "" {
		return name
	}
	if mapped, ok := r.forward[name]; ok {
		return mapped
	}
	base := ToolPrefix + unsafeToolChars.ReplaceAllString(name, "_")
	if len(base) > 64 {
		base = base[:64]
	}
	candidate := base
	for i := 2; ; i++ {
		if _, taken := r.reverse[candidate]; !taken {
			break
		}
		candidate = fmt.Sprintf("%s_%d", base, i)
	}
	r.forward[name] = candidate
	r.reverse[candidate] = name
	return candidate
}

// Restore 把上游返回的工具名还原成客户端声明的名字。
// IsRenamed 判断某个上游工具名是不是我们改写过名的客户端工具。
func (r *Renames) IsRenamed(name string) bool {
	if r == nil {
		return false
	}
	_, ok := r.reverse[name]
	return ok
}

func (r *Renames) Restore(name string) string {
	if r == nil {
		return name
	}
	if original, ok := r.reverse[name]; ok {
		return original
	}
	return name
}

// reservedToolDescription 让模型别去选内置工具：它们只是免费层的形状要求，
// 客户端执行不了。这一招沿用旧 Node 实现（只带 read 时同样这样写）。
const reservedToolDescription = "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

// officialPrompt 生成随模型/环境变化的官方系统提示词。
func officialPrompt(model string) string {
	// 客户端的工作目录不会经过 API 传上来，这里给一个稳定的占位值，
	// 只为了让提示词的结构和真实客户端一致。
	const workdir = "./"
	replacer := strings.NewReplacer(
		"{{MODEL}}", model,
		"{{MODELNAME}}", displayName(model),
		"{{DATE}}", time.Now().UTC().Format("Mon Jan 02 2006"),
		"{{WORKDIR}}", workdir,
		"{{GIT}}", "yes",
	)
	return replacer.Replace(promptTemplate)
}

// displayName 把模型 id 变成人类可读的名字，例如
// deepseek-v4.1-flash-free -> Deepseek V4.1 Flash Free。
func displayName(model string) string {
	parts := strings.Split(model, "-")
	for index, part := range parts {
		if part == "" {
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func officialTools() []any {
	var tools []any
	if err := json.Unmarshal(toolsJSON, &tools); err != nil {
		panic("官方工具集解析失败: " + err.Error())
	}
	// 免费层只把 read 当作必需门禁：实测只发 read 一样 200，而多发的工具只会让模型
	// 以为自己有 shell/文件系统。描述统一写“禁止调用”，进一步降低被选中的概率。
	only := make([]any, 0, 1)
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := tool["function"].(map[string]any)
		if !ok {
			continue
		}
		fn["description"] = reservedToolDescription
		if fn["name"] == "read" {
			only = append(only, tool)
		}
	}
	return only
}

// Build 把客户端的 OpenAI chat 请求整形成官方客户端的形状。
func Build(payload map[string]any, model string) ([]byte, *Renames, error) {
	renames := newRenames()

	rawMessages, _ := payload["messages"].([]any)
	clientSystem := make([]string, 0, 2)
	messages := make([]any, 0, len(rawMessages)+1)
	for _, raw := range rawMessages {
		message, ok := raw.(map[string]any)
		if !ok {
			messages = append(messages, raw)
			continue
		}
		role, _ := message["role"].(string)
		if role != "system" && role != "developer" {
			messages = append(messages, raw)
			continue
		}
		if text := contentText(message["content"]); text != "" {
			clientSystem = append(clientSystem, text)
		}
	}

	system := officialPrompt(model)
	if len(clientSystem) > 0 {
		system += "\n\n" + strings.Join(clientSystem, "\n\n")
	}
	// 客户端没声明任何工具时，明确告诉模型别用内置工具：它们只是免费层的形状要求，
	// 客户端执行不了，真被选中也只能在响应侧丢弃。
	if !hasClientTools(payload) {
		system += "\n\nThe current client provides no tools. Answer directly in text and do not call any tool."
	}
	messages = append([]any{map[string]any{"role": "system", "content": system}}, messages...)

	tools := officialTools()
	if rawTools, ok := payload["tools"].([]any); ok {
		for _, raw := range rawTools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			fn, ok := tool["function"].(map[string]any)
			if !ok {
				continue
			}
			name, _ := fn["name"].(string)
			if name == "" {
				continue
			}
			cloned := map[string]any{}
			for k, v := range tool {
				cloned[k] = v
			}
			clonedFn := map[string]any{}
			for k, v := range fn {
				clonedFn[k] = v
			}
			clonedFn["name"] = renames.rename(name)
			cloned["function"] = clonedFn
			tools = append(tools, cloned)
		}
	}

	// 键顺序对齐官方客户端：model, messages, tools, stream, stream_options, max_completion_tokens
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	write := func(key string, value any) error {
		if buffer.Len() > 1 {
			buffer.WriteByte(',')
		}
		keyJSON, err := json.Marshal(key)
		if err != nil {
			return err
		}
		valueJSON, err := json.Marshal(value)
		if err != nil {
			return err
		}
		buffer.Write(keyJSON)
		buffer.WriteByte(':')
		buffer.Write(valueJSON)
		return nil
	}
	// 上游只接受流式请求：stream:false 直接换回 429，所以一律发 stream:true，
	// 客户端要非流式时由 Aggregate 在本地聚合。
	fields := []struct {
		key   string
		value any
	}{
		{"model", model},
		{"messages", messages},
		{"tools", tools},
		{"stream", true},
		{"stream_options", map[string]any{"include_usage": true}},
		{"max_completion_tokens", outputLimit},
	}
	for _, field := range fields {
		if err := write(field.key, field.value); err != nil {
			return nil, nil, err
		}
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), renames, nil
}

func hasClientTools(payload map[string]any) bool {
	tools, _ := payload["tools"].([]any)
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, ok := tool["function"].(map[string]any); ok {
			return true
		}
	}
	return false
}

func contentText(content any) string {
	switch value := content.(type) {
	case string:
		return strings.TrimSpace(value)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if part, ok := item.(map[string]any); ok {
				if text, ok := part["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.TrimSpace(strings.Join(parts, ""))
	}
	return ""
}
