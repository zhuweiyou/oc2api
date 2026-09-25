// OpenCode Zen 上游客户端：URL、超时、User-Agent、请求构造、模型列表与会话。
import { ocId, safeJsonParse } from "./shared.js"
import { debugLog, logZenResponse } from "./log.js"

const OC_VERSION = "1.18.31"
const ZEN_BASE_URL = "https://opencode.ai"
const ZEN_URL = `${ZEN_BASE_URL}/zen/v1/chat/completions`
const ZEN_MODELS_URL = `${ZEN_BASE_URL}/zen/v1/models`
const FETCH_TIMEOUT_MS = 5 * 60 * 1000

const userSessions = new Map()
let cachedModels = null

function zenUserAgent() {
  return `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`
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

export function buildZenRequest(
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

  // OpenAI 兼容：reasoning_effort 原样透传（"none" 关闭思考，low/medium/high 等开启），
  // 不发明自定义字段，也不擅自改写取值。
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

export async function fetchZen(zenReq, requestId, model, stream) {
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

export async function getAvailableModels() {
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

// Zen 免费层要求 session ID 为 ses_ + 26 位小写十六进制
function zenSessionID() {
  const bytes = new Uint8Array(13)
  globalThis.crypto.getRandomValues(bytes)
  return "ses_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function getSession(user) {
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
