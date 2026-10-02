// 业务端点编排：health、ip、模型列表、chat completions。
import { config } from "./config.js"
import { ocId, sendJson, upstreamErrorResponse } from "./shared.js"
import { debugLog, logZenRequest } from "./log.js"
import { buildUpstreamRequest, fetchUpstream, getSession, isAllowedModelId, listModels } from "./zen.js"
import { respondJson, respondStream } from "./openai.js"

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
    return sendJson(response, { object: "list", data: await listModels() })
  } catch (error) {
    debugLog("[MODEL LIST ERROR]", { message: error?.message || String(error) })
    return upstreamErrorResponse(response, error)
  }
}

export async function chat(request, response) {
  const requestId = ocId("req")
  const input = readBodyJson(request, response)
  if (input === undefined) return
  if (!isRecord(input)) return errorResponse(response, "Invalid JSON body", 400)

  // 只做必要的门面校验：其余字段原样交给上游，避免误拒合法请求。
  if (typeof input.model !== "string" || !input.model.trim()) {
    return errorResponse(response, "model must be a non-empty string", 400)
  }
  if (!isAllowedModelId(input.model)) {
    return errorResponse(response, "Only big-pickle and models ending in -free are allowed", 400)
  }
  if (!Array.isArray(input.messages) || !input.messages.length) {
    return errorResponse(response, "messages must be a non-empty array", 400)
  }

  const stream = input.stream === true
  // reasoning_effort 缺省视为开启思考；只有显式 "none" 才丢弃思考内容。
  const reasoningEffort = input.reasoning_effort ?? input.reasoningEffort
  const thinkingEnabled = reasoningEffort !== "none"

  debugLog("[OAI]", {
    at: new Date().toISOString(),
    user: request.auth.user,
    model: input.model,
    mode: stream ? "stream" : "sync",
    messages: input.messages.length,
  })

  const sessionId = getSession(request.auth.user)
  const upstreamRequest = buildUpstreamRequest(input, sessionId)
  logZenRequest(requestId, "openai", input.model, stream, request.auth.user, upstreamRequest, input.messages.length)

  let upstream
  try {
    upstream = await fetchUpstream(upstreamRequest, { requestId, model: input.model })
  } catch (error) {
    debugLog("[ZEN FETCH ERROR]", {
      requestId,
      model: input.model,
      stream,
      message: error?.message || String(error),
    })
    return upstreamErrorResponse(response, error)
  }

  const ctx = { requestId, model: input.model, thinkingEnabled, status: upstream.status, choiceCount: input.n }
  if (stream) return respondStream(response, upstream, ctx)
  return respondJson(response, upstream, ctx)
}

function errorResponse(response, message, status) {
  return sendJson(
    response,
    { error: { message, type: status === 400 ? "invalid_request_error" : "server_error" } },
    status,
  )
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// rawBody 中间件已缓冲原始流；无效 JSON 返回 OpenAI 风格 400。
function readBodyJson(request, response) {
  try {
    return JSON.parse(String(request.rawBody ?? ""))
  } catch {
    errorResponse(response, "Invalid JSON body", 400)
    return undefined
  }
}
