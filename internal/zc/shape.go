package zc

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
	promptMarker = "You are opencode, an interactive CLI tool"
	clientPrefix = "clint_"
	outputLimit  = 32000
)

// Renames 记录客户端工具名与发往上游的名字之间的双向映射。
type Renames struct {
	forward map[string]string // 客户端名 -> clint_ 名
	reverse map[string]string // clint_ 名 -> 客户端名
}

func newRenames() *Renames {
	return &Renames{forward: map[string]string{}, reverse: map[string]string{}}
}

var unsafeToolChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// rename 把客户端工具名换成 clint_<sanitized>，并保证不与已用的名字冲突。
func (r *Renames) rename(name string) string {
	if name == "" {
		return name
	}
	if mapped, ok := r.forward[name]; ok {
		return mapped
	}
	base := clientPrefix + unsafeToolChars.ReplaceAllString(name, "_")
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
func (r *Renames) Restore(name string) string {
	if r == nil {
		return name
	}
	if original, ok := r.reverse[name]; ok {
		return original
	}
	return name
}

// officialPrompt 生成随模型变化的官方系统提示词：模型名 + 环境块。
func officialPrompt(model string) string {
	prompt := strings.ReplaceAll(promptTemplate, "{{MODEL}}", model)
	// 抓包里的日期/目录是采集机器的，换成当前进程的值，看起来才像真实客户端。
	today := time.Now().UTC().Format("Mon Jan 02 2006")
	prompt = regexp.MustCompile(`Today's date: .*`).ReplaceAllString(prompt, "Today's date: "+today)
	wd := "/workspace"
	prompt = regexp.MustCompile(`Working directory: .*`).ReplaceAllString(prompt, "Working directory: "+wd)
	prompt = regexp.MustCompile(`Workspace root folder: .*`).ReplaceAllString(prompt, "Workspace root folder: "+wd)
	return prompt
}

func officialTools() []any {
	var tools []any
	if err := json.Unmarshal(toolsJSON, &tools); err != nil {
		panic("官方工具集解析失败: " + err.Error())
	}
	return tools
}

// Build 把客户端的 OpenAI chat 请求整形成官方客户端的形状。
func Build(payload map[string]any, model string, _ bool) ([]byte, *Renames, error) {
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
