// Cloudflare Workers 入口：把 oc2api 的 OpenAI 兼容接口跑在边缘。
//
// 与 server/app.js 的 Node 版共用同一套上游适配（server/zen.js）和响应语义
// （server/openai.js + ./respond.js），这里只做 Workers 原生的路由、鉴权与请求体解析。
import { config } from "../../server/config.js"
import { logZenRequest } from "../../server/log.js"
import {
  areToolsDisabled,
  buildUpstreamRequest,
  fetchUpstream,
  isAllowedModelId,
  listModels,
  sessionFor,
  zenBaseUrl,
} from "../../server/zen.js"
import { jsonResponse, respondJson, respondStream } from "./respond.js"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
  "Access-Control-Expose-Headers": "X-Request-Id",
}

const IP_PROVIDERS = ["https://api.ipquery.io", "http://ip-api.com/json"]
const IPV4_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/

// 请求 id：与 Node 版 ocId 同形，便于两边日志对照。
function requestId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const random = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 16)
  return `${prefix}_${Date.now().toString(16)}${random}`
}

function withCors(response) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function authenticate(request, env) {
  const apiKey = env?.API_KEY ?? config.apiKey
  if (!apiKey) return { user: "anonymous" }

  const header = request.headers.get("authorization") || request.headers.get("x-api-key") || ""
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim()
  if (token === apiKey) return { user: "user-default" }

  return {
    error: jsonResponse({ error: { message: "Invalid API key", type: "authentication_error" } }, 401),
  }
}

function errorResponse(message, status) {
  return jsonResponse({ error: { message, type: status === 400 ? "invalid_request_error" : "server_error" } }, status)
}

// 建连失败：超时 504，其余 502，与 Node 版 upstreamErrorResponse 一致。
function upstreamErrorResponse(error) {
  const timeout = error?.message === "timeout"
  return jsonResponse(
    {
      error: {
        message: timeout ? "Upstream timeout" : `Upstream error: ${error?.message || error}`,
        type: timeout ? "timeout_error" : "upstream_error",
      },
    },
    timeout ? 504 : 502,
  )
}

async function health() {
  return jsonResponse({
    status: "ok",
    version: config.version,
    runtime: "cloudflare-worker",
    // 诊断用：确认 vars/secret 是否真的进了 process.env（nodejs_compat）。
    upstream: zenBaseUrl,
    debug: config.debug,
    endpoints: ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health", "/ip"],
  })
}

function isValidIPv4(ip) {
  if (typeof ip !== "string" || !ip) return false
  const parts = ip.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

async function fetchIPFrom(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const match = IPV4_REGEX.exec(await response.text())
    const ip = match ? match[0] : ""
    return isValidIPv4(ip) ? { ip, source: url } : null
  } catch {
    return null
  }
}

async function ip() {
  const results = await Promise.allSettled(IP_PROVIDERS.map((url) => fetchIPFrom(url)))
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return jsonResponse(result.value)
  }
  return jsonResponse({ error: { message: "all IP providers failed", type: "upstream_error" } }, 502)
}

async function models() {
  try {
    return jsonResponse({ object: "list", data: await listModels() })
  } catch (error) {
    return upstreamErrorResponse(error)
  }
}

async function chat(request, env, auth) {
  const id = requestId("req")
  let input
  try {
    input = JSON.parse(await request.text())
  } catch {
    return errorResponse("Invalid JSON body", 400)
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return errorResponse("Invalid JSON body", 400)
  }

  // 与 Node 版一致：只做必要的门面校验，其余字段原样交给上游。
  if (typeof input.model !== "string" || !input.model.trim()) {
    return errorResponse("model must be a non-empty string", 400)
  }
  if (!isAllowedModelId(input.model)) {
    return errorResponse("Only big-pickle and models ending in -free are allowed", 400)
  }
  if (!Array.isArray(input.messages) || !input.messages.length) {
    return errorResponse("messages must be a non-empty array", 400)
  }

  const stream = input.stream === true
  const reasoningEffort = input.reasoning_effort ?? input.reasoningEffort
  const thinkingEnabled = reasoningEffort !== "none"

  const sessionId = sessionFor(auth.user, request, input)
  const upstreamRequest = buildUpstreamRequest(input, sessionId)
  // 与 Node 版 handler 保持一致：DEBUG=true 时输出上游请求摘要（含会话 id）。
  logZenRequest(id, "openai", input.model, stream, auth.user, upstreamRequest, input.messages.length)

  let upstream
  try {
    upstream = await fetchUpstream(upstreamRequest, { requestId: id, model: input.model })
  } catch (error) {
    return upstreamErrorResponse(error)
  }

  const ctx = {
    requestId: id,
    model: input.model,
    thinkingEnabled,
    status: upstream.status,
    choiceCount: input.n,
    toolsDisabled: areToolsDisabled(input),
    toolAliases: upstreamRequest.toolAliases,
    reservedToolNames: upstreamRequest.reservedToolNames,
    clientToolNames: upstreamRequest.clientToolNames,
  }
  return stream ? respondStream(upstream, ctx) : respondJson(upstream, ctx)
}

function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, "")
  return trimmed || "/"
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = normalizePath(url.pathname)

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (path === "/" || path === "/health") return withCors(await health())
    if (path === "/ip") return withCors(await ip())

    const auth = authenticate(request, env)
    if (auth.error) return withCors(auth.error)

    if (path === "/v1/models" || path === "/models") return withCors(await models())
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      if (request.method !== "POST") return withCors(errorResponse("Method not allowed", 405))
      return withCors(await chat(request, env, auth))
    }

    return withCors(jsonResponse({ error: { message: "Not found" } }, 404))
  },
}
