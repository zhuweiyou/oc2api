import express from "express"

const OC_VERSION = "1.18.31"
const PROXY_VERSION = "v2.0.0"
const ZEN_BASE_URL = "https://opencode.ai"
const ZEN_URL = `${ZEN_BASE_URL}/zen/v1/chat/completions`
const ZEN_MODELS_URL = `${ZEN_BASE_URL}/zen/v1/models`
const FETCH_TIMEOUT_MS = 5 * 60 * 1000

const userSessions = new Map()
let cachedModels = null

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
  "Access-Control-Expose-Headers": "X-Request-Id",
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

function zenUserAgent() {
  return `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`
}

export async function handler(request, response) {
  const fetchRequest = isWebRequest(request) ? request : await nodeRequestToFetchRequest(request)
  const fetchResponse = await handleRequest(fetchRequest)

  if (!response) return fetchResponse
  return sendNodeResponse(response, fetchResponse)
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, "") || "/"

  try {
    if (request.method === "GET" && (path === "/" || path === "/health")) return healthResponse()

    if (request.method === "GET" && path === "/ip") return ipResponse()
    // require auth for all other endpoints
    const auth = authenticate(request)
    if (auth.error) return auth.error

    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) return modelsResponse()
    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions"))
      return handleOpenAI(request)

    return jsonResponse({ error: { message: "Not found" } }, 404)
  } catch (error) {
    console.log("[FUNCTION ERROR]", error?.stack || error?.message || error)
    return jsonResponse({ error: { message: "Internal error", type: "server_error" } }, 500)
  }
}

function isWebRequest(request) {
  return typeof request?.headers?.get === "function" && typeof request?.arrayBuffer === "function"
}

async function nodeRequestToFetchRequest(request) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (value !== undefined) {
      headers.set(key, String(value))
    }
  }

  const url = new URL(request.url || "/", nodeRequestOrigin(request))
  const method = request.method || "GET"
  const init = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    init.body = await readNodeRequestBody(request)
    init.duplex = "half"
  }

  return new Request(url, init)
}

function nodeRequestOrigin(request) {
  const forwardedProto = request.headers?.["x-forwarded-proto"]
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || "https")
        .split(",")[0]
        .trim()
  const host = request.headers?.host || "localhost"
  return `${proto || "https"}://${host}`
}

async function readNodeRequestBody(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === "string" || Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
      return request.body
    }
    return JSON.stringify(request.body)
  }

  const chunks = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

async function sendNodeResponse(response, fetchResponse) {
  response.statusCode = fetchResponse.status
  response.statusMessage = fetchResponse.statusText
  fetchResponse.headers.forEach((value, key) => {
    response.setHeader(key, value)
  })

  if (!fetchResponse.body) {
    response.end()
    return
  }

  const reader = fetchResponse.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) {
        await new Promise((resolve) => response.once("drain", resolve))
      }
    }
  } finally {
    response.end()
    reader.releaseLock()
  }
}

async function handleOpenAI(request) {
  const requestId = ocId("req")
  const auth = authenticate(request)
  if (auth.error) return auth.error

  const input = await readJson(request)
  if (input.error) return input.error
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return openAIErrorResponse("Invalid JSON body", "invalid_request_error", 400)
  }

  const { model, messages, stream, tools, tool_choice, max_tokens, max_completion_tokens, temperature } = input.body
  const reasoningEffort = input.body.reasoning_effort ?? input.body.reasoningEffort
  const maxTokens = max_tokens ?? max_completion_tokens

  const sessionId = getSession(auth.user)
  debugLog("[OAI]", {
    at: new Date().toISOString(),
    user: auth.user,
    model,
    mode: stream ? "stream" : "sync",
    messages: messages?.length || 0,
  })

  // Zen 免费层要求 OpenCode 风格的流式请求；客户端是否 stream 由响应层决定。
  const zenReq = buildZenRequest(
    model,
    messages,
    true,
    tools,
    tool_choice,
    reasoningEffort,
    sessionId,
    maxTokens,
    temperature,
  )
  logZenRequest(requestId, "openai", model, stream, auth.user, zenReq, messages?.length || 0)

  let upstream
  try {
    upstream = await fetchZen(zenReq, requestId, model, stream)
  } catch (error) {
    debugLog("[ZEN FETCH ERROR]", { requestId, model, stream: !!stream, message: error?.message || String(error) })
    return upstreamErrorResponse(error)
  }

  const response = stream
    ? await openAIStreamResponse(upstream, requestId, model)
    : await openAIFullStreamResponse(upstream, requestId, model)
  response.headers.set("x-request-id", requestId)
  return response
}

const IP_PROVIDERS = ["https://api.ipquery.io", "http://ip-api.com/json"]

const IPV4_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/

async function ipResponse() {
  const results = await Promise.allSettled(IP_PROVIDERS.map((url) => fetchIPFrom(url)))

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      return jsonResponse({ ip: result.value.ip, source: result.value.source })
    }
  }

  return upstreamErrorResponse(new Error("all IP providers failed"))
}

async function fetchIPFrom(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("timeout"), 10 * 1000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null

    const body = await response.text()
    const match = IPV4_REGEX.exec(body)
    const ip = match ? match[0] : ""
    if (!isValidIPv4(ip)) return null

    return { ip, source: url }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function isValidIPv4(ip) {
  if (typeof ip !== "string" || !ip) return false
  const parts = ip.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

function healthResponse() {
  return jsonResponse({
    status: "ok",
    version: PROXY_VERSION,
    endpoints: ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip"],
  })
}

async function modelsResponse() {
  try {
    return jsonResponse({
      object: "list",
      data: await getAvailableModels(),
    })
  } catch (error) {
    debugLog("[MODEL LIST ERROR]", { message: error?.message || String(error) })
    return upstreamErrorResponse(error)
  }
}

async function getAvailableModels() {
  if (cachedModels) return cachedModels
  cachedModels = await fetchZenModels()
  return cachedModels
}

async function fetchZenModels() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS)

  try {
    const started = Date.now()
    const response = await fetch(ZEN_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer public",
        "User-Agent": zenUserAgent(),
      },
      signal: controller.signal,
    })
    const raw = await response.text()
    const parsed = safeJsonParse(raw)

    if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`)
    if (!Array.isArray(parsed?.data)) throw new Error("Invalid model list response")

    const models = parsed.data.filter((item) => isAllowedModelId(item?.id))

    if (!models.length) throw new Error("No allowed models returned from upstream")

    debugLog("[MODEL LIST]", {
      status: response.status,
      ms: Date.now() - started,
      total: parsed.data.length,
      allowed: models.length,
    })
    return models
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") {
      throw new Error("timeout", { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

const zenCompatibilityToolDescription =
  "Compatibility marker only. Do not call or select this function. Use tools explicitly supplied by the user instead."

function zenCompatibilityTools() {
  const names = ["bash", "edit", "glob", "grep", "read"]
  return names.map((name) => ({
    type: "function",
    function: {
      name,
      description: zenCompatibilityToolDescription,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  }))
}

function toolFunctionName(tool) {
  return tool?.function?.name || ""
}

function appendZenCompatibilityTools(tools) {
  const result = Array.isArray(tools) ? [...tools] : []
  const seen = new Set(result.map(toolFunctionName).filter(Boolean))
  for (const tool of zenCompatibilityTools()) {
    const name = toolFunctionName(tool)
    if (seen.has(name)) continue
    result.push(tool)
    seen.add(name)
  }
  return result
}

function buildZenRequest(
  model,
  messages,
  stream,
  tools,
  toolChoice,
  reasoningEffort,
  sessionId,
  maxTokens,
  temperature,
) {
  const hadUserTools = Array.isArray(tools) && tools.length > 0
  const reqBody = {
    model,
    messages,
    max_tokens: maxTokens ?? 32000,
    stream: !!stream,
    stream_options: { include_usage: true },
    tools: appendZenCompatibilityTools(tools),
  }
  // 没有用户工具时禁止任何工具选择，避免模型选中兼容标记工具。
  if (!hadUserTools) reqBody.tool_choice = "none"
  else if (toolChoice != null) reqBody.tool_choice = toolChoice

  if (reasoningEffort != null && reasoningEffort !== "") {
    reqBody.reasoning_effort = reasoningEffort
  }

  if (temperature != null && temperature !== "") {
    reqBody.temperature = temperature
  }

  return {
    body: JSON.stringify(reqBody),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": zenUserAgent(),
      "x-opencode-client": "desktop",
      "x-opencode-project": "global",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": sessionId,
    },
    messageCount: messages?.length || 0,
  }
}

async function fetchZen(zenReq, requestId, model, stream) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS)

  try {
    const started = Date.now()
    const response = await fetch(ZEN_URL, {
      method: "POST",
      headers: zenReq.headers,
      body: zenReq.body,
      signal: controller.signal,
    })
    logZenResponse({
      requestId,
      model,
      stream: !!stream,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
    })
    return response
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") {
      throw new Error("timeout", { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function openAIFullStreamResponse(upstream, requestId, model) {
  const raw = await upstream.text()
  const zenError = parseZenError(raw)
  logUpstreamBody(requestId, model, upstream.status, raw, zenError)
  // 上游任何错误都归一为 429：下游账号池工具(CLIProxyAPI/sub2api/new-api)依赖 429 切换账号。
  if (upstream.status >= 400 || zenError) {
    return openAIErrorResponse(
      `${zenError?.message || "Rate limit exceeded"} (free model rate limit)`,
      "rate_limit_error",
      429,
      "rate_limit_exceeded",
    )
  }

  const normalizer = createOpenAIStreamNormalizer(model)
  const choices = new Map()
  let responseId = ""
  let created
  let usage

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue

    const parsed = safeJsonParse(payload)
    if (!parsed) continue
    const normalized = normalizer.normalize(parsed)
    if (!normalized) continue
    if (!responseId && typeof normalized.id === "string") responseId = normalized.id
    if (created == null) created = normalized.created
    if (normalized.usage != null) usage = normalized.usage

    if (!Array.isArray(normalized.choices)) continue
    for (const choice of normalized.choices) {
      if (!choice || typeof choice !== "object") continue
      const index = Number.isInteger(choice.index) ? choice.index : 0
      if (!choices.has(index)) {
        choices.set(index, {
          content: "",
          role: "",
          finish: "",
          toolCalls: new Map(),
        })
      }
      const state = choices.get(index)
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {}
      if (typeof delta.role === "string" && delta.role) state.role = delta.role
      if (typeof delta.content === "string") state.content += delta.content
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!call || typeof call !== "object") continue
          const callIndex = Number.isInteger(call.index) ? call.index : state.toolCalls.size
          if (!state.toolCalls.has(callIndex)) {
            state.toolCalls.set(callIndex, { id: "", type: "", name: "", argumentText: "" })
          }
          const toolCall = state.toolCalls.get(callIndex)
          if (typeof call.id === "string" && call.id) toolCall.id = call.id
          if (typeof call.type === "string" && call.type) toolCall.type = call.type
          const fn = call.function && typeof call.function === "object" ? call.function : {}
          if (typeof fn.name === "string" && fn.name) toolCall.name = fn.name
          const argumentFragment = fn["arguments"]
          if (typeof argumentFragment === "string") toolCall.argumentText += argumentFragment
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) state.finish = choice.finish_reason
    }
  }

  const resultChoices = [...choices.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, state]) => {
      const message = {
        role: state.role || "assistant",
        content: state.content,
      }
      if (state.toolCalls.size) {
        message.tool_calls = [...state.toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => ({
            id: call.id,
            type: call.type || "function",
            function: { name: call.name, arguments: call.argumentText },
          }))
      }
      return {
        index,
        message,
        finish_reason: state.finish || "stop",
      }
    })

  const result = {
    id: responseId || requestId,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: resultChoices,
  }
  if (usage != null) result.usage = usage
  return jsonResponse(result, upstream.status)
}

async function openAIStreamResponse(upstream, requestId, model) {
  if (!upstream.body) {
    return openAIErrorResponse("Empty response from upstream", "upstream_error", 502)
  }

  const reader = upstream.body.getReader()
  const first = await reader.read()
  if (first.done) {
    return openAIErrorResponse("Empty response from upstream", "upstream_error", 502)
  }

  const firstText = new TextDecoder().decode(first.value)
  const zenError = parseZenError(firstText)
  logUpstreamBody(requestId, model, upstream.status, firstText, zenError, true)
  if (upstream.status === 429 || zenError) {
    await reader.cancel().catch(() => {})
    return openAIErrorResponse(
      `${zenError?.message || "Rate limit exceeded"} (free model rate limit)`,
      "rate_limit_error",
      429,
      "rate_limit_exceeded",
    )
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const normalizer = createOpenAIStreamNormalizer(model)

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = ""
      let doneSent = false

      const enqueue = (text) => controller.enqueue(encoder.encode(text))
      const sendData = (payload) =>
        enqueue(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
      const sendDone = () => {
        if (doneSent) return
        doneSent = true
        sendData("[DONE]")
      }
      const processLine = (rawLine) => {
        const line = rawLine.trimEnd()
        if (!line.startsWith("data:")) return

        const payload = line.slice(5).trim()
        if (!payload) return
        if (payload === "[DONE]") {
          sendDone()
          return
        }
        if (doneSent) return

        const parsed = safeJsonParse(payload)
        if (!parsed) return

        const normalized = normalizer.normalize(parsed)
        if (normalized) sendData(normalized)
      }
      const processChunk = (chunk) => {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) processLine(line)
      }

      try {
        processChunk(first.value)
        while (!doneSent) {
          const { done, value } = await reader.read()
          if (done) break
          processChunk(value)
        }

        const tail = decoder.decode()
        if (tail) buffer += tail
        if (buffer) processLine(buffer)
        if (doneSent) await reader.cancel().catch(() => {})
        sendDone()
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: upstream.status,
    headers: mergeHeaders(SSE_HEADERS),
  })
}

function createOpenAIStreamNormalizer(model) {
  const contentStates = new Map()

  return {
    normalize(chunk) {
      if (!chunk) return null
      if (!Array.isArray(chunk.choices)) {
        if (chunk.usage == null) return null
        chunk = { ...chunk, choices: [] }
      }
      if (!chunk.choices.length && chunk.cost != null) return null

      const next = { ...chunk }
      delete next.cost
      if (model) next.model = model
      next.choices = chunk.choices.map((choice) => normalizeOpenAIStreamChoice(choice, contentStates)).filter(Boolean)

      if (!next.choices.length && !next.usage) return null
      return next
    },
  }
}

function normalizeOpenAIStreamChoice(choice, contentStates) {
  if (!choice?.delta) return choice

  const delta = { ...choice.delta }
  delete delta.reasoning
  delete delta.reasoning_content

  if (typeof delta.content === "string") {
    const state = getThinkState(contentStates, choice.index ?? 0)
    const visibleContent = stripThinkStreamText(delta.content, state)
    if (visibleContent) delta.content = visibleContent
    else delete delta.content
  }

  if (!Object.keys(delta).length && !choice.finish_reason) return null
  return { ...choice, delta }
}

function stripThinkBlocks(text) {
  if (!/<\/?think>/i.test(text)) return text
  const state = createThinkState()
  return stripThinkStreamText(text, state)
}

function getThinkState(states, key) {
  const stateKey = String(key)
  if (!states.has(stateKey)) states.set(stateKey, createThinkState())
  return states.get(stateKey)
}

function createThinkState() {
  return { inThink: false, emittedContent: false, removedThink: false }
}

function stripThinkStreamText(text, state) {
  let output = ""
  let cursor = 0
  const lower = text.toLowerCase()

  while (cursor < text.length) {
    if (state.inThink) {
      const end = lower.indexOf("</think>", cursor)
      if (end === -1) break
      cursor = end + "</think>".length
      state.inThink = false
      state.removedThink = true
      continue
    }

    const start = lower.indexOf("<think>", cursor)
    if (start === -1) {
      output += text.slice(cursor)
      break
    }

    output += text.slice(cursor, start)
    cursor = start + "<think>".length
    state.inThink = true
    state.removedThink = true
  }

  if (state.removedThink && !state.emittedContent && output) output = output.replace(/^\s+/, "")
  if (output) state.emittedContent = true
  return output
}

function debugLog(label, payload) {
  if (process.env.DEBUG !== "true") return
  console.log(label, JSON.stringify(payload))
}

function logZenRequest(requestId, format, model, stream, user, zenReq, messageCount) {
  if (process.env.DEBUG !== "true") return
  debugLog("[ZEN REQ]", {
    requestId,
    format,
    user,
    model,
    stream: !!stream,
    messageCount,
    bodyBytes: byteLength(zenReq.body),
    ocRequest: shortId(zenReq.headers["x-opencode-request"]),
    ocSession: shortId(zenReq.headers["x-opencode-session"]),
  })
}

function logZenResponse(payload) {
  const { status } = payload
  if (!process.env.DEBUG && status < 400) return
  console.log("[ZEN RES]", JSON.stringify(payload))
}

function logUpstreamBody(requestId, model, status, raw, zenError, firstChunk = false) {
  const body = String(raw || "")
  const shouldLog = process.env.DEBUG || Boolean(zenError) || status >= 400
  if (!shouldLog) return

  const payload = { requestId, model, status, firstChunk, chars: body.length }
  if (zenError) payload.zenError = { message: zenError.message, type: zenError.type }
  if (shouldLog) payload.preview = previewText(body)

  console.log("[ZEN BODY]", JSON.stringify(payload))
}

function byteLength(text) {
  return new TextEncoder().encode(String(text || "")).length
}

function shortId(id) {
  const text = String(id || "")
  if (text.length <= 16) return text
  return `${text.slice(0, 8)}...${text.slice(-6)}`
}

function previewText(text, max = 800) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .slice(0, max)
}

function authenticate(request) {
  const apiKey = process.env.API_KEY
  if (!apiKey) return { user: "anonymous" }

  const header = request.headers.get("authorization") || request.headers.get("x-api-key") || ""
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim()

  if (token === apiKey) return { user: "user-default" }

  return { error: openAIErrorResponse("Invalid API key", "authentication_error", 401) }
}

// Zen 免费层要求 session ID 为 ses_ + 26 位小写十六进制
function zenSessionID() {
  const bytes = new Uint8Array(13)
  globalThis.crypto.getRandomValues(bytes)
  return "ses_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function getSession(user) {
  const now = Date.now()
  const existing = userSessions.get(user)
  if (!existing || now - existing.ts > 30 * 60 * 1000) {
    const next = { id: zenSessionID(), ts: now }
    userSessions.set(user, next)
    return next.id
  }
  existing.ts = now
  return existing.id
}

async function readJson(request) {
  try {
    return { body: await request.json() }
  } catch {
    return { error: openAIErrorResponse("Invalid JSON body", "invalid_request_error", 400) }
  }
}

function parseZenError(raw) {
  const text = String(raw || "").trim()
  if (!text.startsWith("{")) return null
  if (!text.includes("FreeUsageLimitError") && !text.includes('"error"') && !text.includes('"type"')) return null

  const parsed = safeJsonParse(text)
  if (!parsed || (!parsed.error && parsed.type !== "error")) return null

  return {
    message: parsed.error?.message || parsed.message || "Rate limit exceeded",
    type: parsed.error?.type || parsed.type || "upstream_error",
  }
}

function upstreamErrorResponse(error) {
  const timeout = error?.message === "timeout"
  const message = timeout ? "Upstream timeout" : `Upstream error: ${error?.message || error}`
  const type = timeout ? "timeout_error" : "upstream_error"
  const status = timeout ? 504 : 502
  return openAIErrorResponse(message, type, status)
}

function openAIErrorResponse(message, type, status, code) {
  return jsonResponse({ error: { message, type, ...(code ? { code } : {}) } }, status)
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: mergeHeaders(JSON_HEADERS, headers) })
}

function mergeHeaders(...sets) {
  const headers = new Headers(CORS_HEADERS)
  for (const set of sets) {
    for (const [key, value] of Object.entries(set || {})) {
      headers.set(key, value)
    }
  }
  return headers
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function ocId(prefix) {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const rnd = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 16)
  return `${prefix}_${Date.now().toString(16)}${rnd}`
}

// The same Express app is used by the local entrypoint and Vercel's Node runtime.
// Body parsing stays disabled so handler() can preserve the raw request body.
export const app = express()
app.disable("x-powered-by")
app.use((request, response, next) => {
  Promise.resolve(handler(request, response)).catch(next)
})
app.use((error, _request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.setHeader(key, value)
  response.status(500).json({ error: { message: "Internal error", type: "server_error" } })
})

export const __test = {
  buildZenRequest,
  createOpenAIStreamNormalizer,
  isAllowedModelId,
  stripThinkBlocks,
}

export default app
