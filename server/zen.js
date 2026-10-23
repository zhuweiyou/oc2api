// OpenCode V2 上游客户端。对照 2.0.29 源码与真实 CLI 抓包：
//   - 使用 inference/v1、V2 User-Agent 和会话关联 headers，不发送旧的非标准 request ID；
//   - 免费层要求内置 read 工具（名字与参数 schema），只带 read 即可放行，缺 read 一律 403；
//   - 显式 tool_choice:none 也会被 403，改用保留工具描述并在响应层禁止工具调用。
// 不注入 OpenCode 系统提示词；客户端工具名双向映射，消息正文和业务参数保持不变。
import { createHash } from "node:crypto"

import { debugLog } from "./log.js"

// 免费层只在 inference 路径放行：/zen/v1 即便请求本身完全合规也回 403 FreeTier。
// 所以 ZEN_API_BASE_URL 允许沿用旧写法（/zen、/zen/v1、/zen/openai/v1），
// 落到 opencode.ai 时统一改写到 /inference 的同名子路径；自建中继等其它主机原样保留。
export function normalizeZenBase(raw) {
  const base = String(raw || "")
    .trim()
    .replace(/\/+$/, "")
  let url
  try {
    url = new URL(base)
  } catch {
    return base
  }
  if (url.hostname !== "opencode.ai" && !url.hostname.endsWith(".opencode.ai")) return base
  const rest = url.pathname.replace(/^\/zen(?=\/|$)/, "")
  // /zen/go 是付费 Go 网关，和免费层无关，不改写。
  if (rest === url.pathname || rest === "/go" || rest.startsWith("/go/")) return base
  url.pathname = `/inference${rest}`
  return url.toString().replace(/\/+$/, "")
}

// A local relay can recover rejected requests before the adapter sees them.
const ZEN_API_BASE_URL = normalizeZenBase(process.env.ZEN_API_BASE_URL || "https://opencode.ai/inference/v1")
const ZEN_CHAT_URL = `${ZEN_API_BASE_URL}/chat/completions`
const ZEN_MODELS_URL = `${ZEN_API_BASE_URL}/models`

// 供诊断端点展示，避免部署后无法确认实际打到了哪个上游。
export const zenBaseUrl = ZEN_API_BASE_URL

// 对齐 App.useragent：opencode/<channel>/<version>/<client>。
const ZEN_USER_AGENT = "opencode/latest/2.0.29/cli"

// 建立连接与模型列表的超时。注意：响应头之后的读取由 openai.js 的看门狗负责。
const CONNECT_TIMEOUT_MS = Number(process.env.ZEN_CONNECT_TIMEOUT_MS || 60 * 1000)
if (!Number.isFinite(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1 || CONNECT_TIMEOUT_MS > 600000) {
  throw new Error("ZEN_CONNECT_TIMEOUT_MS must be between 1 and 600000 milliseconds")
}

// 上游只把 read 当作必需门禁：实测只带 read 必定放行，只带 shell/edit/write/glob 等一律 403。
// 少注入一个门禁就少一个与客户端工具重名的干扰源，所以只保留 read。
const GATE_TOOL_NAMES = ["read"]

// 这些键名在 JS 里有特殊含义，用户塞进请求体没有任何意义，一律不转发给上游。
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"]

// 旧版「禁止调用」描述。上游不校验文案（空描述同样放行），用最直白的旧写法，
// 不再拼 V2 的业务原句，避免和客户端工具的描述混淆模型。
const GATE_TOOL_DESCRIPTION =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

export function gateTool(name) {
  // 名字和参数 schema 必须保持 V2 read 的形态：改名、空 properties 都会被上游 403。
  return {
    type: "function",
    function: {
      name,
      description: GATE_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: { type: "integer", minimum: 0, description: "Starting line or directory entry (1-based)" },
          limit: { type: "integer", minimum: 0, description: "Maximum lines or directory entries to read" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: false,
    },
  }
}

export function areToolsDisabled(payload) {
  return payload.tool_choice === "none" || !Array.isArray(payload.tools) || payload.tools.length === 0
}

// 上游还校验 edit 等其它内置工具；只改 read/shell 仍会拒绝完整客户端工具集。
// 所有客户端工具统一使用上游别名，schema、调用 ID 和工具结果保持不变。
function withGateTools(tools) {
  const clientTools = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : []
  const present = new Set(clientTools.map((tool) => tool?.function?.name))
  const names = new Map()
  for (const tool of clientTools) {
    const name = tool?.function?.name
    if (typeof name !== "string" || !name || names.has(name)) continue
    const base = `oc2api_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 60)
    let alias = base
    let suffix = 1
    while (present.has(alias)) {
      const tail = `_${suffix++}`
      alias = `${base.slice(0, 64 - tail.length)}${tail}`
    }
    present.add(alias)
    names.set(name, alias)
  }
  const result = clientTools.map((tool) => {
    const renamed = renameToolCall(tool, names)
    if (renamed === tool) return tool
    return {
      ...renamed,
      function: {
        ...renamed.function,
        description: `Client tool "${tool.function.name}"; use "${renamed.function.name}" for the client's "${tool.function.name}" operation. ${tool.function.description || ""}`,
      },
    }
  })
  result.push(...GATE_TOOL_NAMES.map(gateTool))
  return { tools: result, names, aliases: new Map([...names].map(([name, alias]) => [alias, name])) }
}

function renameToolCall(call, names) {
  const name = names.get(call?.function?.name)
  return name ? { ...call, function: { ...call.function, name } } : call
}

function renameToolChoice(choice, names) {
  const renamed = renameToolCall(choice, names)
  if (!Array.isArray(renamed?.tools)) return renamed
  return {
    ...renamed,
    tools: renamed.tools.map((tool) => {
      const next = renameToolCall(tool, names)
      return names.has(next?.name) ? { ...next, name: names.get(next.name) } : next
    }),
  }
}

function renameMessageTools(message, names) {
  let next = message
  if (Array.isArray(message?.tool_calls)) {
    next = { ...next, tool_calls: message.tool_calls.map((call) => renameToolCall(call, names)) }
  }
  const legacyName = names.get(message?.function_call?.name)
  if (legacyName) next = { ...next, function_call: { ...message.function_call, name: legacyName } }
  // 上游对历史消息 role:"tool" 上的 name 支持不一致：GLM 直接 400
  // （`[unsupported_parameter] messages[n]: "name" is not supported`），DeepSeek 则容忍。
  // 该字段在 OpenAI 规范里可选，靠 tool_call_id 已能定位工具结果，
  // 所以一律不发 name：既避开 GLM 的 400，也不改变其它模型的行为。
  if (message?.role === "tool" && next.name !== undefined) {
    next = { ...next }
    delete next.name
  }
  // 老式 role:"function" 消息的 name 是必填（标识被调用的函数），必须保留并改名。
  if (message?.role === "function" && names.has(message.name)) next = { ...next, name: names.get(message.name) }
  return next
}

export function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

// 上游只接受流式；下游是否流式由响应层决定，与这里无关。
export function buildUpstreamRequest(payload, sessionId) {
  const toolsDisabled = areToolsDisabled(payload)
  const adapted = withGateTools(toolsDisabled ? [] : payload.tools)
  const body = {
    ...payload,
    tools: adapted.tools,
    stream: true,
    stream_options: { include_usage: true },
  }

  // 危险键名不转发：JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，
  // 展开后原样带到上游 body 里（实测不污染本地原型，但没有任何透传价值）。
  for (const key of DANGEROUS_KEYS) delete body[key]

  // V2 拒绝 none。禁用时不提供用户工具、只留下带禁止调用提示的保留工具，
  // 响应层再拒绝任何工具调用，不能仅靠提示词保证下游的禁用语义。
  if (toolsDisabled || payload.tool_choice == null) delete body.tool_choice
  else body.tool_choice = renameToolChoice(payload.tool_choice, adapted.names)

  // 必须无条件走一遍消息改写：即使没有客户端工具（names 为空），
  // role:"tool" 上的 name 也要剥掉，否则 GLM 会 400。
  body.messages = payload.messages.map((message) => renameMessageTools(message, adapted.names))

  // 兼容既有 camelCase 别名；上游和官方 SDK 使用 snake_case，不能只影响本地过滤。
  const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort
  delete body.reasoningEffort
  if (reasoningEffort != null && reasoningEffort !== "") body.reasoning_effort = reasoningEffort
  else delete body.reasoning_effort

  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = 32000

  return {
    body: JSON.stringify(body),
    toolAliases: adapted.aliases,
    reservedToolNames: [...GATE_TOOL_NAMES],
    toolNames: body.tools.map((tool) => tool?.function?.name).filter(Boolean),
    clientToolNames: body.tools
      .map((tool) => tool?.function?.name)
      .filter((name) => name && !GATE_TOOL_NAMES.includes(name)),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": ZEN_USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": sessionId,
      "x-opencode-session-id": sessionId,
      "x-session-affinity": sessionId,
      "X-Session-Id": sessionId,
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

// 上游按 x-opencode-session 归并会话：同一个 id 的回合会落到同一台后端，
// 它的 prompt cache 也只按这个 id 命中。所以会话粒度必须是「一段对话」而不是
// 「一个使用者」——否则并行开的两段对话会互相抢同一份缓存，其中一段还会一直
// 命中别人写进去的前缀。这里沿用 OpenCode 自己的做法：一个 seed 对应一个 id，
// 直到空闲 30 分钟。
const SESSION_TTL_MS = 30 * 60 * 1000
// 同时记住的对话数：OpenCode 自己保留最近 1000 段；超出后丢最久未用的。
const SESSION_CACHE_LIMIT = 1000
const sessions = new Map()

// session 头必须符合 OpenCode 的 ID 格式，否则上游一律 403 FreeTier：
// `ses_` + 12 位十六进制 + 14 位 base62（共 30 字符）。首 12 位不是任意十六进制，
// 而是 descending() 的 `~(timestamp * 0x1000 + counter)` 低 48 位：时间戳占高位，
// 低 12 位是取反后的同一毫秒内序号，上游会据此校验（序号过大同样 403）。
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
// 同一个毫秒内允许创建的 id 数；取反后低 12 位必须落在 [0xFF0, 0xFFF]。
const MAX_PER_MILLISECOND = 16

let lastMillisecond = 0
let counterInMillisecond = 0

export function sessionId(timestamp = Date.now()) {
  if (timestamp !== lastMillisecond) {
    lastMillisecond = timestamp
    counterInMillisecond = 0
  }
  const counter = counterInMillisecond++ % MAX_PER_MILLISECOND
  // 与上游 descending() 一致：value = ~(timestamp * 0x1000 + counter) 取低 48 位十六进制。
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter))
  let time = ""
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  return "ses_" + time + [...bytes].map((byte) => ID_CHARS[byte % 62]).join("")
}

// 判断一个 id 是不是 OpenCode 真的可能生成出来的：形状对，且低 12 位是取反后
// 的小序号。客户端塞进来的哈希截断或随便拼的字符串都会被上游 403。
export function isRealSessionId(id) {
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return false
  const low = Number.parseInt(id.slice(13, 16), 16)
  return Number.isInteger(low) && 0xfff - low < MAX_PER_MILLISECOND
}

// 一段对话的 seed。优先级从「调用方明确指定」到「从内容推断」：
//   1. 客户端自己带的合法 x-opencode-session —— OpenCode / Claude Code 等会带；
//   2. 调用方给的会话标识头（x-session-affinity、X-Session-Id、conversation-id）；
//   3. body 的 prompt_cache_key（Codex 的 thread）；
//   4. 首条 user 消息的哈希 —— 多轮对话里它比末条稳定。
// 同一次对话的每一轮得到同一个 seed，两段对话不会因为首句相同而合并（见跨用户隔离）。
export function sessionSeed(request, payload) {
  // Express 的 req.headers 是普通对象，Workers 的 request.headers 是 Headers：
  // 两种都要读得到，否则 Cloudflare 上客户端自带的会话 id 会被静默忽略。
  const header = (name) => {
    const headers = request?.headers
    if (!headers) return ""
    const value = typeof headers.get === "function" ? headers.get(name) : headers[name]
    return typeof value === "string" ? value.trim() : ""
  }

  for (const name of ["x-opencode-session", "x-opencode-session-id"]) {
    const value = header(name)
    if (isRealSessionId(value)) return value
  }
  for (const name of ["x-session-affinity", "x-session-id", "conversation-id"]) {
    const value = header(name)
    if (value) return `header:${value.slice(0, 200)}`
  }

  const cacheKey = payload?.prompt_cache_key
  if (typeof cacheKey === "string" && cacheKey.trim()) return `cache:${cacheKey.trim().slice(0, 200)}`

  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const firstUser = messages.find((message) => message?.role === "user")
  const text = contentText(firstUser?.content)
  if (text) return `first:${createHash("sha256").update(text).digest("hex")}`
  return ""
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim()
}

// seed 已经是一个合法 id 时直接沿用（调用方指定的会话不能被我们改掉）。
export function getSession(seed) {
  if (isRealSessionId(seed)) return seed

  const now = Date.now()
  const existing = sessions.get(seed)
  if (existing) {
    // 重新插入一次，让 Map 的迭代顺序成为最近使用顺序。
    sessions.delete(seed)
    if (now - existing.at >= SESSION_TTL_MS) return remember(seed, sessionId(now), now)
    existing.at = now
    sessions.set(seed, existing)
    return existing.id
  }
  return remember(seed, sessionId(now), now)
}

// 对外入口：按「使用者 + 这段对话」取 session。
// 使用者要参与 seed，否则两个调用方首句相同就会共用同一份上游缓存；
// seed 推不出来（没有消息、没有会话头）时退化成每个使用者一个 session。
export function sessionFor(user, request, payload) {
  const seed = sessionSeed(request, payload)
  if (isRealSessionId(seed)) return seed
  return getSession(`${user || "anonymous"}\x00${seed}`)
}

function remember(seed, id, at) {
  sessions.set(seed, { id, at })
  while (sessions.size > SESSION_CACHE_LIMIT) {
    const oldest = sessions.keys().next().value
    sessions.delete(oldest)
  }
  return id
}
