package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	cryptorand "crypto/rand"

	"gopkg.in/yaml.v3"
)

const (
	ProxyVersion       = "v1.3.0"
	OCVersion          = "1.15.13"
	ZenBaseURL         = "https://opencode.ai"
	ZenURL             = ZenBaseURL + "/zen/v1/chat/completions"
	ZenModelsURL       = ZenBaseURL + "/zen/v1/models"
	defaultTimeout     = 5 * time.Minute
	ImageFallbackModel = "mimo-v2.5-free" // DeepSeek 不支持图片,带图请求路由到该带图模型
)

type Config struct {
	Port      int    `yaml:"port"`
	APIKey    string `yaml:"api-key"`
	Debug     bool   `yaml:"debug"`
	TimeoutMs int    `yaml:"timeout-ms"`
}

var (
	Cfg            *Config
	UserSessions   = &sync.Map{}
	CachedModels   []map[string]interface{}
	CachedModelsMu sync.RWMutex
	zenHTTPClient  = newZenHTTPClient()
)

var CORSHeaders = map[string]string{
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
}

var JSONRespHeaders = map[string]string{
	"Content-Type": "application/json; charset=utf-8",
}

var SSERespHeaders = map[string]string{
	"Content-Type":      "text/event-stream; charset=utf-8",
	"Cache-Control":     "no-cache, no-transform",
	"X-Accel-Buffering": "no",
}

type thinkState struct {
	inThink        bool
	emittedContent bool
	removedThink   bool
}

type zenError struct {
	Message string
	Type    string
}

var thinkBlockRe = regexp.MustCompile(`(?is)<think>([\s\S]*?)<\/think>`)

func newThinkState() *thinkState {
	return &thinkState{}
}

func stripThinkStreamText(state *thinkState, text string) string {
	var output strings.Builder
	cursor := 0
	lower := strings.ToLower(text)

	for cursor < len(text) {
		if state.inThink {
			end := strings.Index(lower[cursor:], "</think>")
			if end == -1 {
				break
			}
			cursor += end + len("</think>")
			state.inThink = false
			state.removedThink = true
			continue
		}

		start := strings.Index(lower[cursor:], "<think>")
		if start == -1 {
			output.WriteString(text[cursor:])
			break
		}

		output.WriteString(text[cursor : cursor+start])
		cursor += start + len("<think>")
		state.inThink = true
		state.removedThink = true
	}

	if state.removedThink && !state.emittedContent && output.Len() > 0 {
		trimmed := strings.TrimLeft(output.String(), " ")
		output.Reset()
		output.WriteString(trimmed)
	}
	if output.Len() > 0 {
		state.emittedContent = true
	}
	return output.String()
}

func extractThinkBlocks(text string) string {
	matches := thinkBlockRe.FindAllStringSubmatch(text, -1)
	var parts []string
	for _, m := range matches {
		content := strings.TrimSpace(m[1])
		if content != "" {
			parts = append(parts, content)
		}
	}
	return strings.Join(parts, "\n")
}

func stripThinkBlocks(text string) string {
	lower := strings.ToLower(text)
	if !strings.Contains(lower, "think") {
		return text
	}
	state := newThinkState()
	return stripThinkStreamText(state, text)
}

func getThinkState(states map[int]*thinkState, key interface{}) *thinkState {
	idx := 0
	switch v := key.(type) {
	case float64:
		idx = int(v)
	case int:
		idx = v
	}
	if _, ok := states[idx]; !ok {
		states[idx] = newThinkState()
	}
	return states[idx]
}

func ocId(prefix string) string {
	bytes := make([]byte, 12)
	cryptorand.Read(bytes)
	encoded := base64.RawURLEncoding.EncodeToString(bytes)
	return fmt.Sprintf("%s_%x%s", prefix, time.Now().UnixNano(), encoded)
}

type session struct {
	id string
	ts int64
}

func getSession(user string) string {
	now := time.Now().UnixMilli()
	if val, ok := UserSessions.Load(user); ok {
		s := val.(*session)
		if now-s.ts < 30*60*1000 {
			s.ts = now
			return s.id
		}
	}
	s := &session{id: ocId("ses"), ts: now}
	UserSessions.Store(user, s)
	return s.id
}

const sessionTTL = 30 * time.Minute

func sessionCleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now().UnixMilli()
		UserSessions.Range(func(key, val any) bool {
			s := val.(*session)
			if now-s.ts > sessionTTL.Milliseconds() {
				UserSessions.Delete(key)
			}
			return true
		})
	}
}

func authenticate(r *http.Request) (string, *apiError) {
	if Cfg.APIKey == "" {
		return "anonymous", nil
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		authHeader = r.Header.Get("X-Api-Key")
	}
	if authHeader == "" {
		authHeader = r.Header.Get("x-api-key")
	}

	token := authHeader
	if len(authHeader) > 7 && strings.EqualFold(authHeader[:7], "bearer ") {
		token = strings.TrimSpace(authHeader[7:])
	}

	if token == Cfg.APIKey {
		return "user-default", nil
	}

	return "", &apiError{
		message: "Invalid API key",
		errType: "authentication_error",
		status:  http.StatusUnauthorized,
	}
}

func debugLog(label string, payload interface{}) {
	if !Cfg.Debug {
		return
	}
	data, _ := json.Marshal(payload)
	log.Println(label, string(data))
}

func byteLength(s string) int {
	return len([]byte(s))
}

func shortId(id string) string {
	if len(id) <= 16 {
		return id
	}
	return id[:8] + "..." + id[len(id)-6:]
}

func previewText(text string, max int) string {
	if max == 0 {
		max = 800
	}
	s := strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	if len(s) > max {
		s = s[:max]
	}
	return s
}

func marshalJSON(v interface{}) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func deepCopy(v interface{}) interface{} {
	b, _ := json.Marshal(v)
	var out interface{}
	json.Unmarshal(b, &out)
	return out
}

func safeUnmarshal(text string) map[string]interface{} {
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil
	}
	return result
}

func getFloat(v interface{}, def float64) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case json.Number:
		f, _ := val.Float64()
		return f
	}
	return def
}

func getInt(v interface{}, def int) int {
	return int(getFloat(v, float64(def)))
}

func getString(v interface{}, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

func JSONResponse(w http.ResponseWriter, data interface{}, status int) {
	b, _ := json.Marshal(data)
	for k, v := range CORSHeaders {
		w.Header().Set(k, v)
	}
	for k, v := range JSONRespHeaders {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
	w.Write(b)
}

func SetCORSHeaders(w http.ResponseWriter) {
	for k, v := range CORSHeaders {
		w.Header().Set(k, v)
	}
}

func SetSSEHeaders(w http.ResponseWriter) {
	for k, v := range SSERespHeaders {
		w.Header().Set(k, v)
	}
	for k, v := range CORSHeaders {
		w.Header().Set(k, v)
	}
}

type apiError struct {
	message string
	errType string
	status  int
	code    string
}

func makeAPIError(message, errType string, status int) *apiError {
	return &apiError{message: message, errType: errType, status: status}
}

func writeAPIError(w http.ResponseWriter, err *apiError) {
	writeOpenAIError(w, err.message, err.errType, err.status, err.code)
}

func writeOpenAIError(w http.ResponseWriter, message, errType string, status int, code string) {
	data := map[string]interface{}{
		"error": map[string]interface{}{
			"message": message,
			"type":    errType,
		},
	}
	if code != "" {
		(data["error"].(map[string]interface{}))["code"] = code
	}
	JSONResponse(w, data, status)
}

func writeUpstreamError(w http.ResponseWriter, err error) {
	msg := err.Error()
	errType := "upstream_error"
	status := http.StatusBadGateway
	prefix := "Upstream error: "
	if msg == "timeout" || msg == "context deadline exceeded" ||
		strings.Contains(msg, "deadline exceeded") || strings.Contains(msg, "Timeout exceeded") {
		msg = "Upstream timeout"
		errType = "timeout_error"
		status = http.StatusGatewayTimeout
		prefix = ""
	}
	writeOpenAIError(w, prefix+msg, errType, status, "")
}

func fetchZenModels() ([]map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ResolveTimeout(Cfg))
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", ZenModelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", fmt.Sprintf("opencode/%s ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13", OCVersion))

	started := time.Now()
	resp, err := zenHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	debugLog("[MODEL LIST]", map[string]interface{}{
		"status": resp.StatusCode,
		"ms":     int(time.Since(started).Milliseconds()),
	})

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Model list returned HTTP %d", resp.StatusCode)
	}

	parsed := safeUnmarshal(string(raw))
	if parsed == nil {
		return nil, fmt.Errorf("Invalid model list response")
	}

	data, ok := parsed["data"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("Invalid model list response")
	}

	var models []map[string]interface{}
	for _, item := range data {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if id, ok := m["id"].(string); ok && isAllowedModelId(id) {
			models = append(models, m)
		}
	}

	if len(models) == 0 {
		return nil, fmt.Errorf("No allowed models returned from upstream")
	}

	return models, nil
}

func isAllowedModelId(id string) bool {
	return id == "big-pickle" || strings.HasSuffix(id, "-free")
}

func getAvailableModels() ([]map[string]interface{}, error) {
	CachedModelsMu.RLock()
	if CachedModels != nil {
		defer CachedModelsMu.RUnlock()
		return CachedModels, nil
	}
	CachedModelsMu.RUnlock()

	CachedModelsMu.Lock()
	defer CachedModelsMu.Unlock()

	if CachedModels != nil {
		return CachedModels, nil
	}

	models, err := fetchZenModels()
	if err != nil {
		return nil, err
	}
	CachedModels = models
	return models, nil
}

type parsedBody struct {
	Body     map[string]interface{}
	ParseErr *apiError
}

func readRequestBody(r *http.Request) *parsedBody {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return &parsedBody{
			ParseErr: makeAPIError("Invalid JSON body", "invalid_request_error", http.StatusBadRequest),
		}
	}

	var body map[string]interface{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return &parsedBody{
			ParseErr: makeAPIError("Invalid JSON body", "invalid_request_error", http.StatusBadRequest),
		}
	}

	return &parsedBody{Body: body}
}

type zenRequest struct {
	Body    string
	Headers map[string]string
}

const reasoningPlaceholder = " "

func injectReasoningContent(model string, body map[string]interface{}) map[string]interface{} {
	if body == nil || body["messages"] == nil {
		return body
	}

	messages, ok := body["messages"].([]interface{})
	if !ok {
		return body
	}

	var changed bool
	for _, msg := range messages {
		m, ok := msg.(map[string]interface{})
		if !ok {
			continue
		}
		if getString(m["role"], "") != "assistant" {
			continue
		}
		if getString(m["reasoning_content"], "") != "" {
			continue
		}
		if deepSeekRegex.MatchString(model) {
			changed = true
			break
		}
	}

	if !changed {
		return body
	}

	next := deepCopy(body).(map[string]interface{})
	msgs, _ := next["messages"].([]interface{})
	for _, msg := range msgs {
		m, ok := msg.(map[string]interface{})
		if !ok {
			continue
		}
		if getString(m["role"], "") != "assistant" {
			continue
		}
		if getString(m["reasoning_content"], "") != "" {
			continue
		}
		if deepSeekRegex.MatchString(model) {
			m["reasoning_content"] = reasoningPlaceholder
		}
	}
	return next
}

var deepSeekRegex = regexp.MustCompile(`(?i)deepseek`)

// DeepSeek 是否需要图片回退:仅当最近一条 user 消息带图时路由到 mimo。
// 历史残留的图片不触发,避免后续纯文字追问一直走 mimo。
func lastUserMessageHasImage(messages []interface{}) bool {
	for i := len(messages) - 1; i >= 0; i-- {
		m, ok := messages[i].(map[string]interface{})
		if !ok {
			continue
		}
		if getString(m["role"], "") != "user" {
			continue
		}
		content, ok := m["content"].([]interface{})
		if !ok {
			return false
		}
		for _, part := range content {
			p, ok := part.(map[string]interface{})
			if !ok {
				continue
			}
			if t := getString(p["type"], ""); t == "image_url" || t == "image" {
				return true
			}
		}
		return false
	}
	return false
}

func deepSeekNeedsImageFallback(model string, messages []interface{}) bool {
	return deepSeekRegex.MatchString(model) && lastUserMessageHasImage(messages)
}

func buildZenRequest(model string, messages, tools []interface{}, toolChoice interface{}, reasoningEffort, sessionId string, stream bool) *zenRequest {
	body := map[string]interface{}{
		"model":    model,
		"messages": messages,
		"stream":   stream,
	}
	// 按实际发送的模型判断:路由到图片模型时跳过 DS 专属的 reasoning_effort
	if deepSeekRegex.MatchString(model) {
		if reasoningEffort != "high" && reasoningEffort != "max" {
			reasoningEffort = "high"
		}
		body["reasoning_effort"] = reasoningEffort
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	if toolChoice != nil {
		body["tool_choice"] = toolChoice
	}

	bodyBytes, _ := json.Marshal(body)

	headers := map[string]string{
		"Content-Type":       "application/json",
		"Authorization":      "Bearer public",
		"User-Agent":         fmt.Sprintf("opencode/%s ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13", OCVersion),
		"x-opencode-client":  "desktop",
		"x-opencode-project": "global",
		"x-opencode-request": ocId("msg"),
		"x-opencode-session": sessionId,
	}
	if stream {
		headers["Accept"] = "text/event-stream"
	}

	return &zenRequest{
		Body:    string(bodyBytes),
		Headers: headers,
	}
}

func fetchZen(ctx context.Context, zenReq *zenRequest) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", ZenURL, strings.NewReader(zenReq.Body))
	if err != nil {
		return nil, err
	}
	for k, v := range zenReq.Headers {
		req.Header.Set(k, v)
	}
	client := zenHTTPClient
	if client == nil {
		client = newZenHTTPClient()
	}
	return client.Do(req)
}

func parseZenError(raw string) *zenError {
	text := strings.TrimSpace(raw)
	if !strings.HasPrefix(text, "{") {
		return nil
	}
	if !strings.Contains(text, "FreeUsageLimitError") &&
		!strings.Contains(text, `"error"`) &&
		!strings.Contains(text, `"type"`) {
		return nil
	}

	parsed := safeUnmarshal(text)
	if parsed == nil {
		return nil
	}

	errMap, _ := parsed["error"].(map[string]interface{})
	if errMap == nil && parsed["type"] != "error" {
		return nil
	}

	message := "Rate limit exceeded"
	if errMap != nil {
		if msg, ok := errMap["message"].(string); ok {
			message = msg
		}
	}
	if msg, ok := parsed["message"].(string); ok {
		message = msg
	}

	errType := "upstream_error"
	if errMap != nil {
		if et, ok := errMap["type"].(string); ok {
			errType = et
		}
	}
	if et, ok := parsed["type"].(string); ok {
		errType = et
	}

	return &zenError{Message: message, Type: errType}
}

func logZenRequest(requestId, format, model string, stream bool, user string, zenReq *zenRequest, messageCount int) {
	debugLog("[ZEN REQ]", map[string]interface{}{
		"requestId":    requestId,
		"format":       format,
		"user":         user,
		"model":        model,
		"stream":       stream,
		"messageCount": messageCount,
		"bodyBytes":    byteLength(zenReq.Body),
		"ocRequest":    shortId(zenReq.Headers["x-opencode-request"]),
		"ocSession":    shortId(zenReq.Headers["x-opencode-session"]),
	})
}

func logZenResponse(env string, payload map[string]interface{}) {
	if !Cfg.Debug {
		status := getFloat(payload["status"], 0)
		if int(status) < 400 {
			return
		}
	}
	log.Println("[ZEN RES]", marshalJSON(payload))
}

func logUpstreamBody(env, requestId, model string, status int, raw string, zenErr *zenError, firstChunk bool) {
	body := raw
	shouldLog := Cfg.Debug || status >= 400 || zenErr != nil
	if !shouldLog {
		return
	}

	shouldPrintPreview := zenErr != nil || status >= 400 || Cfg.Debug
	payload := map[string]interface{}{
		"requestId":  requestId,
		"model":      model,
		"status":     status,
		"firstChunk": firstChunk,
		"chars":      len(body),
	}
	if zenErr != nil {
		payload["zenError"] = map[string]interface{}{
			"message": zenErr.Message,
			"type":    zenErr.Type,
		}
	}
	if shouldPrintPreview {
		payload["preview"] = previewText(body, 800)
	}

	log.Println("[ZEN BODY]", marshalJSON(payload))
}

func normalizeOpenAIFullData(data map[string]interface{}, model string) map[string]interface{} {
	next := deepCopy(data).(map[string]interface{})
	if model != "" {
		next["model"] = model
	}
	choices, ok := next["choices"].([]interface{})
	if !ok {
		return next
	}

	var newChoices []interface{}
	for _, c := range choices {
		choice, ok := c.(map[string]interface{})
		if !ok {
			newChoices = append(newChoices, c)
			continue
		}
		if choice["message"] == nil {
			newChoices = append(newChoices, choice)
			continue
		}

		message := deepCopy(choice["message"]).(map[string]interface{})
		normalizeReasoningField(message)

		if content, ok := message["content"].(string); ok {
			reasoning := extractThinkBlocks(content)
			if reasoning != "" && message["reasoning_content"] == nil {
				message["reasoning_content"] = reasoning
			}
			visible := stripThinkBlocks(content)
			if visible != content {
				message["content"] = visible
			}
		}

		newChoice := deepCopy(choice).(map[string]interface{})
		newChoice["message"] = message
		newChoices = append(newChoices, newChoice)
	}

	next["choices"] = newChoices
	return next
}

type streamNormalizer struct {
	contentStates map[int]*thinkState
	model         string
}

func newStreamNormalizer(model string) *streamNormalizer {
	return &streamNormalizer{contentStates: make(map[int]*thinkState), model: model}
}

func (n *streamNormalizer) normalize(chunk map[string]interface{}) map[string]interface{} {
	if chunk == nil {
		return nil
	}

	choices, ok := chunk["choices"].([]interface{})
	if !ok {
		return nil
	}

	if len(choices) == 0 && chunk["cost"] != nil {
		return nil
	}

	next := deepCopy(chunk).(map[string]interface{})
	delete(next, "cost")
	if n.model != "" {
		next["model"] = n.model
	}

	var newChoices []interface{}
	for _, c := range choices {
		choice, ok := c.(map[string]interface{})
		if !ok {
			newChoices = append(newChoices, c)
			continue
		}
		normalized := normalizeStreamChoice(choice, n.contentStates)
		if normalized != nil {
			newChoices = append(newChoices, normalized)
		}
	}

	next["choices"] = newChoices
	if len(newChoices) == 0 && next["usage"] == nil {
		return nil
	}
	return next
}

func normalizeStreamChoice(choice map[string]interface{}, states map[int]*thinkState) map[string]interface{} {
	delta, ok := choice["delta"].(map[string]interface{})
	if !ok {
		return choice
	}

	deltaCopy := deepCopy(delta).(map[string]interface{})
	normalizeReasoningField(deltaCopy)

	if content, ok := deltaCopy["content"].(string); ok {
		state := getThinkState(states, choice["index"])
		visible := stripThinkStreamText(state, content)
		if visible != "" {
			deltaCopy["content"] = visible
		} else {
			delete(deltaCopy, "content")
		}
	}

	if len(deltaCopy) == 0 && getString(choice["finish_reason"], "") == "" {
		return nil
	}

	result := deepCopy(choice).(map[string]interface{})
	result["delta"] = deltaCopy
	return result
}

func normalizeReasoningField(target map[string]interface{}) {
	if target == nil {
		return
	}
	reasoning, ok := target["reasoning"].(string)
	if ok && reasoning != "" && target["reasoning_content"] == nil {
		target["reasoning_content"] = reasoning
	}
	delete(target, "reasoning")
}

func HandleOpenAI(w http.ResponseWriter, r *http.Request, env string) {
	requestId := ocId("req")
	user, authErr := authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}

	input := readRequestBody(r)
	if input.ParseErr != nil {
		writeAPIError(w, input.ParseErr)
		return
	}

	model := getString(input.Body["model"], "")
	messages, _ := input.Body["messages"].([]interface{})
	stream := false
	if s, ok := input.Body["stream"].(bool); ok {
		stream = s
	}
	tools, _ := input.Body["tools"].([]interface{})
	toolChoice := input.Body["tool_choice"]
	reasoningEffort := getString(input.Body["reasoning_effort"], "")
	if reasoningEffort == "" {
		reasoningEffort = getString(input.Body["reasoningEffort"], "")
	}

	sessionId := getSession(user)

	useImageModel := deepSeekNeedsImageFallback(model, messages)
	upstreamModel := model
	if useImageModel {
		upstreamModel = ImageFallbackModel
	}
	transformedBody := injectReasoningContent(upstreamModel, input.Body)
	transformedMessages, _ := transformedBody["messages"].([]interface{})

	msgSummary := formatMsgSummary(transformedMessages)
	log.Println("[OAI]", time.Now().UTC().Format(time.RFC3339), user, model,
		map[bool]string{true: "stream", false: "sync"}[stream], "msgs:", msgSummary)

	zenReq := buildZenRequest(upstreamModel, transformedMessages, tools, toolChoice, reasoningEffort, sessionId, stream)
	logZenRequest(requestId, "openai", model, stream, user, zenReq, len(messages))

	upstream, err := fetchZen(r.Context(), zenReq)
	if err != nil {
		debugLog("[ZEN FETCH ERROR]", map[string]interface{}{
			"requestId": requestId, "model": upstreamModel, "stream": stream,
			"message": err.Error(),
		})
		writeUpstreamError(w, err)
		return
	}
	defer upstream.Body.Close()

	logZenResponse(env, map[string]interface{}{
		"requestId": requestId, "model": upstreamModel, "stream": stream,
		"status": upstream.StatusCode, "ok": upstream.StatusCode < 400,
		"ms": 0,
	})

	if stream {
		OpenAIStreamResponse(w, r, upstream, requestId, model, env)
		return
	}
	OpenAIFullResponse(w, upstream, requestId, model, env)
}

func OpenAIFullResponse(w http.ResponseWriter, upstream *http.Response, requestId, model, env string) {
	raw, err := io.ReadAll(upstream.Body)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}

	data := safeUnmarshal(string(raw))
	zenErr := parseZenError(string(raw))
	logUpstreamBody(env, requestId, model, upstream.StatusCode, string(raw), zenErr, false)

	if upstream.StatusCode == http.StatusTooManyRequests || zenErr != nil {
		msg := "Rate limit exceeded"
		if zenErr != nil {
			msg = zenErr.Message
		}
		writeOpenAIError(w, msg+" (free model rate limit)", "rate_limit_error",
			http.StatusTooManyRequests, "rate_limit_exceeded")
		return
	}

	if data != nil && data["choices"] != nil {
		JSONResponse(w, normalizeOpenAIFullData(data, model), upstream.StatusCode)
		return
	}

	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	for k, v := range CORSHeaders {
		w.Header().Set(k, v)
	}
	w.WriteHeader(upstream.StatusCode)
	w.Write(raw)
}

func OpenAIStreamResponse(w http.ResponseWriter, r *http.Request, upstream *http.Response, requestId, model, env string) {
	if upstream.Body == nil {
		writeOpenAIError(w, "Empty response from upstream", "upstream_error", http.StatusBadGateway, "")
		return
	}

	peeker := bufio.NewReaderSize(upstream.Body, 64*1024)
	firstText, err := peeker.ReadString('\n') // 跨大行不截断
	if err != nil && firstText == "" {        // EOF 且无任何字节 → 空 body
		writeOpenAIError(w, "Empty response from upstream", "upstream_error", http.StatusBadGateway, "")
		return
	}
	firstText = strings.TrimRight(firstText, "\n")

	zenErr := parseZenError(firstText)
	if upstream.StatusCode == http.StatusTooManyRequests || zenErr != nil {
		logUpstreamBody(env, requestId, model, upstream.StatusCode, firstText, zenErr, true)
		msg := "Rate limit exceeded"
		if zenErr != nil {
			msg = zenErr.Message
		}
		writeOpenAIError(w, msg+" (free model rate limit)", "rate_limit_error",
			http.StatusTooManyRequests, "rate_limit_exceeded")
		return
	}

	SetSSEHeaders(w)
	w.WriteHeader(upstream.StatusCode)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	normalizer := newStreamNormalizer(model)
	doneSent := false

	sendSSE := func(data interface{}) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(w, "data: %s\n\n", string(b))
		flusher.Flush()
	}

	sendDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}

	processLine := func(line string) {
		if !strings.HasPrefix(line, "data:") {
			return
		}
		payload := strings.TrimSpace(line[5:])
		if payload == "" || payload == "[DONE]" {
			if payload == "[DONE]" {
				sendDone()
			}
			return
		}

		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			return
		}

		normalized := normalizer.normalize(parsed)
		if normalized != nil {
			sendSSE(normalized)
		}
	}

	if firstText != "" {
		processLine(firstText)
	}

	scanner := bufio.NewScanner(peeker)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 64*1024*1024)
	for scanner.Scan() {
		processLine(scanner.Text())
		if r.Context().Err() != nil {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		log.Println("[SSE SCAN ERROR]", err)
	}

	sendDone()
}

func formatMsgSummary(messages []interface{}) string {
	var parts []string
	for _, msg := range messages {
		m, ok := msg.(map[string]interface{})
		if !ok {
			continue
		}
		role := getString(m["role"], "?")
		var length int
		if content, ok := m["content"].(string); ok {
			length = len(content)
		} else {
			length = len(marshalJSON(m["content"]))
		}
		parts = append(parts, fmt.Sprintf("%s:%d", role, length))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		SetCORSHeaders(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	SetCORSHeaders(w)

	path := strings.TrimRight(r.URL.Path, "/")
	if path == "" {
		path = "/"
	}

	switch {
	case r.Method == "GET" && path == "/":
		HealthResponse(w)
	case r.Method == "GET" && path == "/health":
		HealthResponse(w)
	case r.Method == "GET" && path == "/ip":
		IPResponse(w, r)
	case r.Method == "GET" && (path == "/v1/models" || path == "/models"):
		ModelsResponse(w, r)
	case r.Method == "POST" && (path == "/v1/chat/completions" || path == "/chat/completions"):
		HandleOpenAI(w, r, "")
	default:
		JSONResponse(w, map[string]interface{}{"error": map[string]interface{}{"message": "Not found"}}, http.StatusNotFound)
	}
}

var ipv4Regex = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)

var ipProviders = []string{
	"https://api.ipquery.io",
	"http://ip-api.com/json",
}

func IPResponse(w http.ResponseWriter, r *http.Request) {
	type result struct {
		ip     string
		source string
	}
	results := make(chan result, len(ipProviders))
	for _, url := range ipProviders {
		url := url
		go func() {
			results <- fetchIPFrom(url)
		}()
	}

	for range ipProviders {
		res := <-results
		if res.ip != "" {
			JSONResponse(w, map[string]interface{}{
				"ip":     res.ip,
				"source": res.source,
			}, http.StatusOK)
			return
		}
	}
	writeUpstreamError(w, fmt.Errorf("all IP providers failed"))
}

func fetchIPFrom(url string) (result struct {
	ip     string
	source string
}) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return
	}
	if resp.StatusCode != http.StatusOK {
		return
	}

	if m := ipv4Regex.FindString(string(body)); m != "" && net.ParseIP(m) != nil && net.ParseIP(m).To4() != nil {
		result.ip = m
		result.source = url
	}
	return
}

func HealthResponse(w http.ResponseWriter) {
	JSONResponse(w, map[string]interface{}{
		"status":    "ok",
		"version":   ProxyVersion,
		"endpoints": []string{"/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip"},
	}, http.StatusOK)
}

func ModelsResponse(w http.ResponseWriter, r *http.Request) {
	user, authErr := authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	_ = user

	models, err := getAvailableModels()
	if err != nil {
		debugLog("[MODEL LIST ERROR]", map[string]interface{}{"message": err.Error()})
		writeUpstreamError(w, err)
		return
	}
	JSONResponse(w, map[string]interface{}{
		"object": "list",
		"data":   models,
	}, http.StatusOK)
}

func LoadConfig() *Config {
	cfg := &Config{
		Port: 8080,
	}

	data, err := os.ReadFile("config.yaml")
	if err != nil {
		log.Println("No config.yaml found, using defaults")
		return cfg
	}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		log.Println("Failed to parse config.yaml:", err)
		return cfg
	}

	return cfg
}

func ResolveTimeout(cfg *Config) time.Duration {
	if Cfg != nil && Cfg.TimeoutMs > 0 {
		return time.Duration(cfg.TimeoutMs) * time.Millisecond
	}
	return defaultTimeout
}

func newZenHTTPClient() *http.Client {
	// ResponseHeaderTimeout 覆盖「连接 + 等待响应头」，等价于 JS 的 FETCH_TIMEOUT_MS；
	// 不设整体 Timeout，避免长流被硬切（body 流式读取无时长上限）。
	return &http.Client{
		Transport: &http.Transport{ResponseHeaderTimeout: ResolveTimeout(Cfg)},
	}
}

func main() {
	log.SetOutput(os.Stdout)
	Cfg = LoadConfig()
	// 包变量区初始化时 Cfg 还是 nil，这里重建 client 让 timeout-ms 生效
	zenHTTPClient = newZenHTTPClient()

	go sessionCleanupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/", Handler)

	port := fmt.Sprintf("%d", Cfg.Port)
	if Cfg.Port == 0 {
		port = "8080"
	}

	log.Println("OC2API server running on http://localhost:" + port)
	log.Println("Health check: http://localhost:" + port + "/health")
	log.Println("Version:", ProxyVersion)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadTimeout:       ResolveTimeout(Cfg),
		WriteTimeout:      0, // 关闭写超时，SSE 长流不被切
		IdleTimeout:       ResolveTimeout(Cfg),
		ReadHeaderTimeout: ResolveTimeout(Cfg),
	}

	log.Fatal(server.ListenAndServe())
}
