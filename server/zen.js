// OpenCode Zen 上游客户端。免费层的硬门槛（均对真实上游逐项验证过）：
//   1. User-Agent 必须形如 opencode/<version>，其他一律 403；
//   2. 必须带 x-opencode-session（ses_ + 26 位小写十六进制）；
//   3. 请求体必须含 bash / read 两个"门禁工具"，缺失即 403；
//   4. stream 必须为 true，stream:false 一律 403。
// 除此之外上游就是标准 OpenAI 协议，本模块只补齐上述条件，业务字段原样透传。
import { ocId } from "./shared.js"
import { debugLog } from "./log.js"

const ZEN_BASE_URL = "https://opencode.ai"
const ZEN_CHAT_URL = `${ZEN_BASE_URL}/zen/v1/chat/completions`
const ZEN_MODELS_URL = `${ZEN_BASE_URL}/zen/v1/models`

// 上游通过 UA 判断请求是否来自 OpenCode 客户端；版本号对判定无影响（已验证）。
const ZEN_USER_AGENT = "opencode/1.18.31"

// 建立连接与模型列表的超时。注意：响应头之后的读取由 openai.js 的看门狗负责。
const CONNECT_TIMEOUT_MS = 60 * 1000

// 免费层门禁要求的工具名。只放必需的 bash / read（已验证最小集）。
const GATE_TOOL_NAMES = ["bash", "read"]

// 这些键名在 JS 里有特殊含义，用户塞进请求体没有任何意义，一律不转发给上游。
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"]

const GATE_TOOL_DESCRIPTION =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

export function gateTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: GATE_TOOL_DESCRIPTION,
      parameters: { type: "object", properties: {} },
    },
  }
}

// 用户已经自带同名工具时保留用户定义，只补缺失的门禁工具。
function withGateTools(tools) {
  const result = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : []
  const present = new Set(result.map((tool) => tool?.function?.name).filter((name) => typeof name === "string"))
  for (const name of GATE_TOOL_NAMES) {
    if (present.has(name)) continue
    result.push(gateTool(name))
    present.add(name)
  }
  return result
}

export function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

// 上游只接受流式；下游是否流式由响应层决定，与这里无关。
export function buildUpstreamRequest(payload, sessionId) {
  const body = {
    ...payload,
    tools: withGateTools(payload.tools),
    stream: true,
    stream_options: { include_usage: true },
  }

  // 危险键名不转发：JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，
  // 展开后原样带到上游 body 里（实测不污染本地原型，但没有任何透传价值）。
  for (const key of DANGEROUS_KEYS) delete body[key]

  // 没有任何用户工具时禁止模型选中门禁工具；有用户工具时沿用下游的选择。
  const hasUserTools = Array.isArray(payload.tools) && payload.tools.length > 0
  if (!hasUserTools) body.tool_choice = "none"
  else if (payload.tool_choice != null) body.tool_choice = payload.tool_choice
  else delete body.tool_choice

  // 兼容既有 camelCase 别名；上游和官方 SDK 使用 snake_case，不能只影响本地过滤。
  const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort
  delete body.reasoningEffort
  if (reasoningEffort != null && reasoningEffort !== "") body.reasoning_effort = reasoningEffort
  else delete body.reasoning_effort

  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = 32000

  return {
    body: JSON.stringify(body),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": ZEN_USER_AGENT,
      "x-opencode-client": "desktop",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": sessionId,
    },
  }
}

// 只在建立连接阶段计时；响应头一到就交给调用方，避免把长回答误杀。
export async function fetchUpstream(request, ctx) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)
  const started = Date.now()

  try {
    const response = await fetch(ZEN_CHAT_URL, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    debugLog("[ZEN RES]", {
      requestId: ctx.requestId,
      model: ctx.model,
      status: response.status,
      ms: Date.now() - started,
    })
    return response
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let cachedModels = null

export async function listModels() {
  if (cachedModels) return cachedModels
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(ZEN_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer public",
        "User-Agent": ZEN_USER_AGENT,
      },
      signal: controller.signal,
    })
    const parsed = await response.json().catch((error) => {
      if (error instanceof SyntaxError) return null
      throw error
    })
    if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`)
    if (!Array.isArray(parsed?.data)) throw new Error("Invalid model list response")

    const models = parsed.data.filter((item) => isAllowedModelId(item?.id))
    if (!models.length) throw new Error("No allowed models returned from upstream")

    cachedModels = models
    return models
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// 上游按 x-opencode-session 归并会话；同一使用者复用同一个 session 直到过期。
const SESSION_TTL_MS = 30 * 60 * 1000
const userSessions = new Map()

export function getSession(user) {
  const now = Date.now()
  const existing = userSessions.get(user)
  if (existing && now - existing.at < SESSION_TTL_MS) {
    existing.at = now
    return existing.id
  }
  const bytes = new Uint8Array(13)
  crypto.getRandomValues(bytes)
  const id = "ses_" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  userSessions.set(user, { id, at: now })
  return id
}
