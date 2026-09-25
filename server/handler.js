// 业务端点编排：health、ip、模型列表、chat completions。
import { config } from "./config.js"
import { ocId, openAIErrorResponse, sendJson, upstreamErrorResponse } from "./shared.js"
import { debugLog, logZenRequest } from "./log.js"
import { buildZenRequest, fetchZen, getAvailableModels, getSession } from "./zen.js"
import { openAIFullStreamResponse, openAIStreamResponse } from "./openai.js"

export function health(_request, response) {
  sendJson(response, {
    status: "ok",
    version: config.version,
    endpoints: ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip"],
  })
}

const IP_PROVIDERS = ["https://api.ipquery.io", "http://ip-api.com/json"]

const IPV4_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/

export async function ip(_request, response) {
  const results = await Promise.allSettled(IP_PROVIDERS.map((url) => fetchIPFrom(url)))

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      return sendJson(response, { ip: result.value.ip, source: result.value.source })
    }
  }

  return upstreamErrorResponse(response, new Error("all IP providers failed"))
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

export async function models(_request, response) {
  try {
    return sendJson(response, {
      object: "list",
      data: await getAvailableModels(),
    })
  } catch (error) {
    debugLog("[MODEL LIST ERROR]", { message: error?.message || String(error) })
    return upstreamErrorResponse(response, error)
  }
}

export async function chat(request, response) {
  const requestId = ocId("req")
  const input = readBodyJson(request, response)
  if (input === undefined) return
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return openAIErrorResponse(response, "Invalid JSON body", "invalid_request_error", 400)
  }

  const { model, messages, stream, tools, tool_choice, max_tokens, max_completion_tokens, temperature } = input
  const reasoningEffort = input.reasoning_effort ?? input.reasoningEffort
  const thinkingEnabled = reasoningEffort !== "none"
  const maxTokens = max_tokens ?? max_completion_tokens

  const sessionId = getSession(request.auth.user)
  debugLog("[OAI]", {
    at: new Date().toISOString(),
    user: request.auth.user,
    model,
    mode: stream ? "stream" : "sync",
    reasoningEffort,
    thinkingEnabled,
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
  logZenRequest(requestId, "openai", model, stream, request.auth.user, zenReq, messages?.length || 0)

  let upstream
  try {
    upstream = await fetchZen(zenReq, requestId, model, stream)
  } catch (error) {
    debugLog("[ZEN FETCH ERROR]", { requestId, model, stream: !!stream, message: error?.message || String(error) })
    return upstreamErrorResponse(response, error)
  }

  if (stream) return openAIStreamResponse(response, upstream, requestId, model, thinkingEnabled)
  return openAIFullStreamResponse(response, upstream, requestId, model, thinkingEnabled)
}

// rawBody 中间件已缓冲原始流；无大小限制，无效 JSON 返回 OpenAI 风格 400。
function readBodyJson(request, response) {
  try {
    return JSON.parse(String(request.rawBody ?? ""))
  } catch {
    openAIErrorResponse(response, "Invalid JSON body", "invalid_request_error", 400)
    return undefined
  }
}
