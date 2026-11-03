package shape

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	// clientToolDigestLength 是客户端工具名摘要取多少位十六进制字符。12 位对一次
	// 请求里那几个工具远不到碰撞线。关键是上游不能看到原始工具名：免费层会拒绝
	// “工具列表里仍带着别的客户端词汇”的请求体（和额度耗尽同样是 429）。
	clientToolDigestLength = 12
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

// rename 把客户端工具名换成一个不透明的 <ToolPrefix><摘要>，并保证不与已用的
// 名字冲突。摘要固定取 SHA-256 的前 12 位十六进制，同一个客户端工具在同一进程内
// 始终映射到同一个上游名字；原始工具名一个字符都不出现在请求体里。
func (r *Renames) rename(name string) string {
	if name == "" {
		return name
	}
	if mapped, ok := r.forward[name]; ok {
		return mapped
	}
	digest := sha256.Sum256([]byte(name))
	base := ToolPrefix + hex.EncodeToString(digest[:])[:clientToolDigestLength]
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

// reservedToolDescription 让模型别去选内置工具：它们只是免费层的形状要求，
// 客户端执行不了，真被选中也只能在响应侧丢弃。
const reservedToolDescription = "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

func officialTools() []any {
	var tools []any
	if err := json.Unmarshal(toolsJSON, &tools); err != nil {
		panic("官方工具集解析失败: " + err.Error())
	}
	// 整套内置工具都发给上游（形状校验依赖这一点），但描述统一换成
	// “禁止调用”：客户端执行不了这些工具，真被选中也只能在响应侧丢弃。
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
	}
	return tools
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

	// 键顺序对齐官方客户端：model, messages, tools, stream, stream_options,
	// max_completion_tokens 打头，其余透传参数按固定顺序追加。
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	write := func(key string, value any) error {
		keyJSON, err := marshalValue(key)
		if err != nil {
			return err
		}
		valueJSON, err := marshalValue(value)
		if err != nil {
			return err
		}
		if !first {
			buffer.WriteByte(',')
		}
		first = false
		buffer.Write(keyJSON)
		buffer.WriteByte(':')
		buffer.Write(valueJSON)
		return nil
	}
	// 上游只接受流式请求：stream:false 直接换回 429，所以一律发 stream:true，
	// 客户端要非流式时由 Aggregate 在本地聚合。
	for _, field := range []struct {
		key   string
		value any
	}{
		{"model", model},
		{"messages", messages},
		{"tools", tools},
		{"stream", true},
		{"stream_options", map[string]any{"include_usage": true}},
		{"max_completion_tokens", completionLimit(payload)},
	} {
		if err := write(field.key, field.value); err != nil {
			return nil, nil, err
		}
	}
	// 透传客户端的采样与工具控制参数。官方客户端会带这些字段，丢掉会让
	// temperature / tool_choice 等静默失效。只透传已知安全的白名单字段。
	for _, key := range forwardedParams {
		value, ok := payload[key]
		if !ok || value == nil {
			continue
		}
		if key == "tool_choice" {
			value = rewriteToolChoice(value, renames)
		}
		if err := write(key, value); err != nil {
			return nil, nil, err
		}
	}
	if legacy, ok := payload["function_call"]; ok && legacy != nil {
		if err := write("function_call", rewriteFunctionCall(legacy, renames)); err != nil {
			return nil, nil, err
		}
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), renames, nil
}

// forwardedParams 是从客户端请求原样透传给上游的参数白名单（顺序固定）。
// stream / stream_options / max_completion_tokens 由整形逻辑统一决定，不放这里。
var forwardedParams = []string{
	"temperature", "top_p",
	"reasoning_effort", "parallel_tool_calls", "prompt_cache_key",
	"tool_choice",
}

// completionLimit 决定请求体里的输出上限：客户端显式给了就尊重它
// （max_completion_tokens 优先，其次 max_tokens），否则用官方客户端的 32000。
func completionLimit(payload map[string]any) any {
	if value, ok := payload["max_completion_tokens"]; ok && value != nil {
		return value
	}
	if value, ok := payload["max_tokens"]; ok && value != nil {
		return value
	}
	return outputLimit
}

// rewriteToolChoice 把 tool_choice 里引用的客户端工具名改写成发往上游的摘要名；
// 否则 tool_choice 指向的工具在上游不存在，请求会自相矛盾。
// 返回克隆后的对象，绝不原地改客户端 payload：非流式为空时我们会用同一份
// payload 重试一次，原地改名会把已经改过的名字再哈希一遍。
func rewriteToolChoice(value any, renames *Renames) any {
	choice, ok := value.(map[string]any)
	if !ok {
		return value
	}
	cloned := make(map[string]any, len(choice))
	for key, item := range choice {
		cloned[key] = item
	}
	if fn, ok := choice["function"].(map[string]any); ok {
		fnCloned := make(map[string]any, len(fn))
		for key, item := range fn {
			fnCloned[key] = item
		}
		if name, ok := fnCloned["name"].(string); ok && name != "" {
			fnCloned["name"] = renames.rename(name)
		}
		cloned["function"] = fnCloned
	}
	if name, ok := cloned["name"].(string); ok && name != "" {
		cloned["name"] = renames.rename(name)
	}
	return cloned
}

// rewriteFunctionCall 处理旧版 function_call 里的工具名，同样返回克隆对象。
func rewriteFunctionCall(value any, renames *Renames) any {
	call, ok := value.(map[string]any)
	if !ok {
		return value
	}
	cloned := make(map[string]any, len(call))
	for key, item := range call {
		cloned[key] = item
	}
	if name, ok := cloned["name"].(string); ok && name != "" {
		cloned["name"] = renames.rename(name)
	}
	return cloned
}

// marshalValue 按 JSON.stringify 的方式编码：不把 < > & 转义成 \u003c 等。
// encoding/json 默认会转义，而工具描述、代码片段里到处都是这些字符，转义后
// 请求体字节就和真实客户端不同（上游连请求体也做指纹）。
func marshalValue(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
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
