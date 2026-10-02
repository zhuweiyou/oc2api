// OpenAI 兼容响应层。
//
// 上游除以下三点外就是标准 OpenAI 协议，所以这里只做"最小必要改写"，
// 不解析、不重组正文内容：
//   1. 思考字段归一：上游有的模型用 reasoning / reasoning_details，
//      下游统一认 reasoning_content；
//   2. 清理上游私有扩展（cost、delta.name），并补齐 usage/finish_reason 的存在性；
//   3. 错误归一：上游任何失败都以 429 返回，供下游账号池切换。
// 上游只支持流式，所以非流式下游请求在这里把 SSE 聚合回一个 JSON 对象。
import { logUpstreamBody } from "./log.js"

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

// 响应头之后没有任何数据的兜底窗口（上游建连后彻底静默时用来自行了断）。
const FIRST_EVENT_TIMEOUT_MS = 30 * 1000
const BODY_IDLE_TIMEOUT_MS = 120 * 1000
// [DONE] 之后仍读一小段：上游可能把 usage 排在它后面。
const TRAILING_USAGE_TIMEOUT_MS = 1000

class ZenStreamError extends Error {
  constructor(message) {
    super(typeof message === "string" ? message : message?.message || "Upstream stream error")
    this.name = "ZenStreamError"
  }
}

// 上游一切失败都归一为 429：下游账号池工具（CLIProxyAPI/sub2api/new-api）依赖它切号。
export function rateLimitError(message) {
  return {
    error: {
      message: `${message || "Rate limit exceeded"} (free model rate limit)`,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    },
  }
}

function sendJson(response, body, status = 200, headers = {}) {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
  response.status(status).json(body)
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---- 正文改写：只动字段名与私有扩展，不重新组装文本 ----

function normalizeDelta(delta, thinkingEnabled) {
  if (!delta || typeof delta !== "object") return delta
  const next = { ...delta }

  // 上游私有扩展：下游 schema 里没有，原样透传会让严格客户端报错。
  delete next.name
  delete next.cost

  // 思考字段归一：reasoning 优先，reasoning_details 只是同一内容的镜像（实测一致）。
  let reasoning = ""
  if (typeof delta.reasoning === "string") reasoning = delta.reasoning
  else if (typeof delta.reasoning_content === "string") reasoning = delta.reasoning_content
  delete next.reasoning
  delete next.reasoning_content
  delete next.reasoning_details
  if (thinkingEnabled && reasoning) next.reasoning_content = reasoning

  return next
}

function normalizeChunk(chunk, model, thinkingEnabled) {
  if (!chunk || typeof chunk !== "object") return null
  const next = { ...chunk }
  delete next.cost
  if (model) next.model = model
  // 上游在部分帧里显式发 usage:null，归一成"没有 usage"更贴近 OpenAI。
  if (next.usage === null) delete next.usage

  if (Array.isArray(next.choices)) {
    next.choices = next.choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return null
        const normalized = { ...choice }
        if (normalized.delta != null) normalized.delta = normalizeDelta(normalized.delta, thinkingEnabled)
        return normalized
      })
      .filter(Boolean)
  }
  return next
}

function hasContent(chunk) {
  if (!Array.isArray(chunk?.choices)) return false
  return chunk.choices.some((choice) => {
    const delta = choice?.delta
    if (!delta) return false
    return Object.keys(delta).some((key) => key !== "role")
  })
}

// ---- SSE 解析：按事件切分，正确处理跨网络块与多字节字符 ----

export async function* readEvents(reader, ctx) {
  const decoder = new TextDecoder()
  let buffer = ""
  let data = []
  let eventType = ""
  let sawAny = false
  let lastEventAt = Date.now()
  // [DONE] 之后只等一小段（上游偶尔把 usage 排在它后面）。没有这个截止时间的话，
  // 上游发完 [DONE] 却不关连接时会一直挂到空闲窗口，等于每个请求白等两分钟。
  let trailingUntil = 0

  const takeEvent = () => {
    const event = { payload: data.join("\n").trim(), type: eventType }
    data = []
    eventType = ""
    return event.payload ? event : null
  }

  const readLine = (line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (!line) return takeEvent()
    if (line.startsWith(":")) return null
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") eventType = value
    return null
  }

  const parse = (event) => {
    if (event.payload === "[DONE]") {
      if (!trailingUntil) trailingUntil = Date.now() + TRAILING_USAGE_TIMEOUT_MS
      return null
    }
    const parsed = safeParse(event.payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ZenStreamError("Invalid SSE payload from upstream")
    }
    const failure = upstreamError(parsed, event.type === "error")
    if (failure) {
      logUpstreamBody(ctx.requestId, ctx.model, ctx.status, event.payload, failure)
      throw new ZenStreamError(failure.message)
    }
    return parsed
  }

  while (true) {
    let budget = (sawAny ? BODY_IDLE_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS) - (Date.now() - lastEventAt)
    // [DONE] 之后改用尾段预算：它是一个"总共还能等多久"的截止时间，
    // 等满即视为流正常结束（上游常常发完 [DONE] 就不再说话，这不是错误）。
    const trailing = trailingUntil > 0
    if (trailing) budget = Math.min(budget, trailingUntil - Date.now())
    if (trailing && budget <= 0) return
    let result
    try {
      result = await raceRead(reader, budget)
    } catch (error) {
      if (trailing) return // 尾段等不到更多数据就是正常收尾
      if (error instanceof ZenStreamError) throw error
      throw new ZenStreamError(error?.message || "Failed to read upstream stream")
    }
    const text = result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
    lastEventAt = Date.now()
    if (!result.done) sawAny = true
    buffer += text

    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event = readLine(line)
      if (!event) continue
      const chunk = parse(event)
      yield chunk ?? null // null 代表 [DONE]
    }

    if (result.done) {
      if (buffer) {
        const event = readLine(buffer)
        if (event) yield parse(event) ?? null
      }
      const event = takeEvent()
      if (event) yield parse(event) ?? null
      return
    }
  }
}

function raceRead(reader, budgetMs) {
  if (budgetMs <= 0) return Promise.reject(new ZenStreamError("Upstream stream idle timeout"))
  let timer
  const raced = Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      // 不 unref：这是一个正在生效的截止时间，必须真的会触发。
      timer = setTimeout(() => reject(new ZenStreamError("Upstream stream idle timeout")), budgetMs)
    }),
  ]).finally(() => clearTimeout(timer))
  // 调用方可能已放弃这次读取（例如 [DONE] 的尾段预算用尽），别让迟到结果变成未处理拒绝。
  raced.catch(() => {})
  return raced
}

// 上游错误体可能是 {error:{...}}、{error:"..."} 或 {type:"error"}，统一提取可读信息。
export function upstreamError(parsed, forced = false) {
  if (!parsed || typeof parsed !== "object") return null
  if (!forced && !parsed.error && parsed.type !== "error") return null
  const message =
    (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
    parsed.message ||
    "Upstream request failed"
  return { message }
}

// ---- 上游连接与下游断开 ----

function watchClose(response, reader) {
  let closed = response.destroyed === true || response.writableEnded === true
  const onClose = () => {
    closed = true
    reader.cancel().catch(() => {})
  }
  if (closed) onClose()
  else response.once("close", onClose)
  return {
    get closed() {
      return closed
    },
    release() {
      response.off("close", onClose)
      reader.cancel().catch(() => {})
    },
  }
}

// 上游错误响应的正文只用于诊断，必须有界读取，否则上游不结束时请求会挂着。
async function readErrorBody(upstream, ctx) {
  const fallback = `Upstream returned HTTP ${upstream.status}`
  if (!upstream.body) return fallback
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let read = 0
  const deadline = Date.now() + 1000
  while (read < 64 * 1024) {
    const budget = deadline - Date.now()
    if (budget <= 0) break
    const step = await raceRead(reader, budget).catch(() => ({ done: true }))
    if (step.done) break
    text += decoder.decode(step.value, { stream: true })
    read += step.value.byteLength
  }
  await reader.cancel().catch(() => {})
  logUpstreamBody(ctx.requestId, ctx.model, upstream.status, text, null)
  return upstreamError(safeParse(text), true)?.message || fallback
}

// ---- 对外两种响应模式 ----

export async function respondStream(response, upstream, ctx) {
  if (!upstream.ok) return sendJson(response, rateLimitError(await readErrorBody(upstream, ctx)), 429)
  if (!upstream.body) return sendJson(response, rateLimitError("Empty response from upstream"), 429)

  const reader = upstream.body.getReader()
  const client = watchClose(response, reader)
  let started = false
  let sawDone = false
  let sawChoice = false
  let sawFinish = false
  let trailingAt = 0

  // 首个有效事件之前不提交 SSE 头，这样还能退回普通 JSON 错误。
  const write = async (text) => {
    if (client.closed || response.destroyed || response.writableEnded) return
    if (!started) {
      response.status(upstream.status)
      for (const [key, value] of Object.entries(SSE_HEADERS)) response.setHeader(key, value)
      response.setHeader("x-request-id", ctx.requestId)
      response.flushHeaders()
      started = true
    }
    if (response.write(text)) return
    await new Promise((resolve) => {
      if (client.closed || response.destroyed || response.writableEnded) return resolve()
      const done = () => {
        response.off("drain", done)
        response.off("close", done)
        resolve()
      }
      response.once("drain", done)
      response.once("close", done)
    })
  }
  const send = (payload) => write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)

  try {
    for await (const chunk of readEvents(reader, ctx)) {
      if (client.closed) break
      if (chunk === null) {
        sawDone = true
        trailingAt = Date.now()
        continue
      }
      // [DONE] 之后只补齐 usage，越界正文不再写进已经结束的响应。
      if (sawDone && (!chunk.usage || Date.now() - trailingAt > TRAILING_USAGE_TIMEOUT_MS)) continue
      const normalized = normalizeChunk(chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue
      for (const choice of normalized.choices ?? []) {
        if (typeof choice.finish_reason === "string" && choice.finish_reason) sawFinish = true
      }
      const hasChoices = Boolean(normalized.choices?.length)
      // 既没有 choices 也没有 usage 的帧（上游结尾的 {choices:[],cost}）没有转发价值。
      if (!hasChoices && !normalized.usage) continue
      // 纯 usage 帧不构成"已经有内容"：在首个 choice 之前它不该提交 SSE 头，
      // 否则后面的"空响应"判断就再也退不回 JSON 错误了。
      if (!hasChoices && !sawChoice) continue
      if (hasContent(normalized)) sawChoice = true
      await send(normalized)
      if (client.closed) break
    }
    if (client.closed) return
    if (!sawChoice) throw new ZenStreamError("Empty response from upstream")
    // 上游需要在 [DONE] 或 finish_reason 处收尾；两者都没有说明流被截断，
    // 不能补 [DONE] 把半截回答伪装成正常完成。
    if (!sawDone && !sawFinish) throw new ZenStreamError("Incomplete response from upstream")
    await send("[DONE]")
  } catch (error) {
    if (!(error instanceof ZenStreamError)) throw error
    if (client.closed || response.destroyed) return
    if (!started) return sendJson(response, rateLimitError(error.message), 429)
    // 响应头已提交，只能以 SSE 错误事件结束，且不补 [DONE]（避免伪装成正常完成）。
    await send(rateLimitError(error.message))
  } finally {
    client.release()
    if (started && !client.closed && !response.destroyed && !response.writableEnded) response.end()
  }
}

export async function respondJson(response, upstream, ctx) {
  if (!upstream.ok) return sendJson(response, rateLimitError(await readErrorBody(upstream, ctx)), 429)
  if (!upstream.body) return sendJson(response, rateLimitError("Empty response from upstream"), 429)

  const reader = upstream.body.getReader()
  const client = watchClose(response, reader)
  const choices = new Map()
  let id = ""
  let created
  let usage
  let sawDone = false

  try {
    for await (const chunk of readEvents(reader, ctx)) {
      if (client.closed) return
      if (chunk === null) {
        sawDone = true
        continue
      }
      if (sawDone && !chunk.usage) continue
      const normalized = normalizeChunk(chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue

      if (!id && typeof normalized.id === "string") id = normalized.id
      if (created == null) created = normalized.created
      if (normalized.usage) usage = normalized.usage

      for (const choice of normalized.choices ?? []) {
        const index = Number.isInteger(choice.index) ? choice.index : 0
        if (!choices.has(index)) choices.set(index, { role: "assistant", content: "", reasoning: "", calls: new Map() })
        const state = choices.get(index)
        const delta = choice.delta ?? {}
        if (typeof delta.role === "string" && delta.role) state.role = delta.role
        if (typeof delta.content === "string") state.content += delta.content
        if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content
        for (const call of delta.tool_calls ?? []) {
          const callIndex = Number.isInteger(call.index) ? call.index : state.calls.size
          if (!state.calls.has(callIndex)) state.calls.set(callIndex, { id: "", name: "", arguments: "" })
          const target = state.calls.get(callIndex)
          if (typeof call.id === "string" && call.id) target.id = call.id
          if (typeof call.function?.name === "string" && call.function.name) target.name = call.function.name
          if (typeof call.function?.arguments === "string") target.arguments += call.function.arguments
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) state.finish = choice.finish_reason
      }
    }
    if (client.closed) return
    if (!choices.size) throw new ZenStreamError("Empty response from upstream")
    // 流在没有 [DONE]、choice 也没有 finish_reason 的情况下结束 = 被截断，
    // 不能给下游一个看似正常的完成（下面的 ?? "stop" 会掩盖这一点）。
    if (!sawDone && [...choices.values()].some((state) => !state.finish)) {
      throw new ZenStreamError("Incomplete response from upstream")
    }

    const result = {
      id: id || ctx.requestId,
      object: "chat.completion",
      created: created ?? Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [...choices.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, state]) => {
          const message = { role: state.role, content: state.content || null }
          if (state.reasoning) message.reasoning_content = state.reasoning
          if (state.calls.size) {
            message.tool_calls = [...state.calls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, call]) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              }))
          }
          return { index, message, finish_reason: state.finish ?? "stop" }
        }),
    }
    if (usage) result.usage = usage
    response.setHeader("x-request-id", ctx.requestId)
    response.status(upstream.status).json(result)
  } catch (error) {
    if (!(error instanceof ZenStreamError)) throw error
    if (!client.closed && !response.destroyed) sendJson(response, rateLimitError(error.message), 429)
  } finally {
    client.release()
  }
}
