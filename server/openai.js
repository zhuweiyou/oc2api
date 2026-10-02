// OpenAI 兼容响应层：上游本就是 OpenAI 协议，这里只做最小必要改写
// （思考字段归一为 reasoning_content、剥掉 cost/delta.name、失败归一为 429），
// 不解析也不重组正文。上游只支持流式，非流式请求在这里把 SSE 聚合成 JSON。
//
// 完成语义有几处反直觉，改动前先看 tests/node/response.test.js：
//   - finish_reason 与 [DONE] 同为完成信号，要据此提前收尾，不能干等空闲窗口；
//   - 完成信号之后的帧只吸收 usage，越界正文既不写入也不产生新 choice；
//   - "明确完成的空回答"算成功（对齐 opencode 官方），只回 usage 而无 choice 才算异常；
//   - 首个正文之前只压住少量无内容帧（保留退回 JSON 429 的能力），上限恒定，
//     上游异常刷屏时直接放行而不是无界攒内存。
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
// 首个正文之前允许压住的无内容帧数上限：正常流量只需 1~2 帧（role + 可能的首个空帧），
// 这个上限只是为了让"上游异常刷屏"时内存保持 O(1)。
const MAX_PENDING_FRAMES = 8

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
  // 头已提交（部署层或其它中间件先 flush 过）时不能再改状态码/头，
  // 否则抛 ERR_HTTP_HEADERS_SENT 会让请求既不响应也不结束。
  if (response.headersSent) return
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

// 完成信号之后的帧只保留 usage：正文不能再写进已经结束的响应，
// 但上游常把 usage 与空 choices 合并在一帧里，所以要按字段剥离而不是整帧丢弃。
function usageOnly(chunk) {
  if (!chunk || typeof chunk !== "object") return null
  if (chunk.usage == null) return null
  return { ...chunk, choices: [] }
}

// ---- SSE 解析：按事件切分，正确处理跨网络块与多字节字符 ----

/** 帧里是否带任何 choice 的 finish_reason —— 它与 [DONE] 同样是完成信号。 */
function hasFinishReason(chunk) {
  return (chunk?.choices ?? []).some((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason)
}

// 流式侧就地改写 finish_reason：工具调用帧先到，finish 帧后到，所以到 finish 帧时
// 已经知道本响应是否带工具调用。
function rewriteFinishReason(chunk, sawToolCalls) {
  for (const choice of chunk.choices ?? []) {
    if (choice.finish_reason) choice.finish_reason = normalizeFinish(choice.finish_reason, sawToolCalls ? 1 : 0)
  }
}

// 上游约 40% 的情况下把「带工具调用」的响应标成 finish_reason:"stop"（实测 big-pickle）。
// opencode 官方对此会归一为 tool-calls，下游据此才会去执行工具而不是当作回答结束。
function normalizeFinish(reason, toolCallCount) {
  return reason === "stop" && toolCallCount > 0 ? "tool_calls" : reason
}

// 非流式聚合必须带上流式会透传、但聚合器未专门处理的 delta 字段，否则同一份
// 上游响应在两种模式下结果不同。字符串增量拼接、对象递归合并——上游会把
// function_call 的 name 与 arguments 拆在不同帧，直接覆盖会丢掉先到的字段。
function mergePassthrough(state, delta) {
  for (const [key, value] of Object.entries(delta)) {
    if (key === "role" || key === "content" || key === "reasoning_content" || key === "tool_calls") continue
    if (value == null) continue
    state.extra[key] = mergeValue(state.extra[key], value)
  }
}

function mergeValue(existing, incoming) {
  if (existing === undefined) return incoming
  if (typeof incoming === "string" && typeof existing === "string") return existing + incoming
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged = { ...existing }
    for (const [key, value] of Object.entries(incoming)) {
      if (value == null) continue
      merged[key] = mergeValue(existing[key], value)
    }
    return merged
  }
  return incoming
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export async function* readEvents(reader, ctx) {
  const decoder = new TextDecoder()
  let buffer = ""
  let data = []
  let eventType = ""
  let sawAny = false
  let lastEventAt = Date.now()
  // 完成信号之后只再等一小段收尾部 usage，否则上游不关连接时会挂到空闲窗口。
  let trailingUntil = 0

  const beginTrailer = () => {
    if (!trailingUntil) trailingUntil = Date.now() + TRAILING_USAGE_TIMEOUT_MS
  }

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
    // 尾段状态必须在每个事件解析时重新判断：同一个网络块里可能同时含有
    // [DONE] 和它后面的帧，用循环开始时的快照会漏判。
    const trailing = trailingUntil > 0
    if (event.payload === "[DONE]") {
      beginTrailer()
      return null
    }
    const parsed = safeParse(event.payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // 尾段已经拿到过完成信号，回答是完整的：尾部残缺/垃圾不足以推翻它。
      if (trailing) return null
      throw new ZenStreamError("Invalid SSE payload from upstream")
    }
    const failure = upstreamError(parsed, event.type === "error")
    if (failure) {
      if (trailing) return null // 迟到的错误事件同理，不能毁掉已完成的回答
      logUpstreamBody(ctx.requestId, ctx.model, ctx.status, event.payload, failure)
      throw new ZenStreamError(failure.message)
    }
    if (hasFinishReason(parsed)) beginTrailer()
    return parsed
  }

  while (true) {
    let budget = (sawAny ? BODY_IDLE_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS) - (Date.now() - lastEventAt)
    // 完成信号之后改用尾段预算：它是一个"总共还能等多久"的截止时间，
    // 等满即视为流正常结束（上游常常发完就不再说话，这不是错误）。
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
      yield chunk ?? null // null 代表完成信号（[DONE] 或 finish_reason 之后的尾段）
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

// 统一提取上游各种错误体形态的可读信息。
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
  let sawFinish = false
  // sawContent：是否出现过正文增量；sawChoiceFrame：是否出现过 choice 帧（截断判定用）。
  let sawContent = false
  let sawChoiceFrame = false
  let sawToolCalls = false
  // 首个正文之前先压住少量无内容帧（role / 空 delta / 纯 usage），这样上游随后报错
  // 还能退回 JSON 429。上限保证内存恒定 O(1)：正常流量下只有 1~2 帧，
  // 一旦上游异常刷屏就直接放行，不再为"保留 429"而无界攒内存。
  const pending = []

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
        continue
      }
      // 带 finish_reason 的这一帧本身要先按原样转发（它承载完成原因），
      // 之后的越界帧才只吸收 usage。
      const completes = sawDone || sawFinish
      if (hasFinishReason(chunk)) sawFinish = true
      const normalized = normalizeChunk(completes ? usageOnly(chunk) : chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue
      const hasChoices = Boolean(normalized.choices?.length)
      // 上游结尾的 {choices:[],cost} 之类空帧没有转发价值。
      if (!hasChoices && !normalized.usage) continue
      if (hasChoices) sawChoiceFrame = true
      // 工具调用帧总在 finish 帧之前到达，所以这里能判断出该不该改写 finish_reason。
      if (normalized.choices?.some((choice) => choice.delta?.tool_calls?.length)) sawToolCalls = true
      rewriteFinishReason(normalized, sawToolCalls)

      if (!hasContent(normalized)) {
        // 无内容帧：还没开始输出就先压住（保留退回 JSON 429 的能力），
        // 超过上限说明上游在异常刷屏，直接放行避免无界攒内存。
        if (!sawContent && pending.length < MAX_PENDING_FRAMES) {
          pending.push(normalized)
          continue
        }
        await send(normalized)
        if (client.closed) break
        continue
      }
      // 首个正文到达：先把压住的帧按序放出，再写正文。
      sawContent = true
      for (const buffered of pending.splice(0)) await send(buffered)
      await send(normalized)
      if (client.closed) break
    }
    if (client.closed) return
    // 无完成信号即截断，不能补 [DONE] 伪装成正常完成。
    if (!sawDone && !sawFinish) throw new ZenStreamError("Incomplete response from upstream")
    // 明确完成的空回答算成功，但只回 usage 而无 choice 属上游异常。
    // pending 里只有无内容帧，不算有效输出。
    if (!sawChoiceFrame && !sawContent) throw new ZenStreamError("Empty response from upstream")
    for (const buffered of pending.splice(0)) await send(buffered)
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

// 找到该 tool_call 增量应并入的槽位（新建或续传）。
// 上游的并行调用各占一帧且常常不带 index，所以不能只按 index 归并：
//   - 带 index：按 index 归档；
//   - 不带 index 但带新 id / 新函数名：说明是另一个调用，新建槽位；
//   - 不带 index 且只有 arguments（参数续传）：并入当前最后一个调用。
function toolCallTarget(state, call) {
  if (Number.isInteger(call.index)) {
    if (!state.calls.has(call.index)) state.calls.set(call.index, { id: "", name: "", arguments: "" })
    return state.calls.get(call.index)
  }
  const startsNew =
    (typeof call.id === "string" && call.id) || (typeof call.function?.name === "string" && call.function.name)
  const last = [...state.calls.values()].at(-1)
  if (!startsNew && last) return last
  const slot = state.calls.size
  state.calls.set(slot, { id: "", name: "", arguments: "" })
  return state.calls.get(slot)
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
  let sawFinish = false

  try {
    for await (const chunk of readEvents(reader, ctx)) {
      if (client.closed) return
      if (chunk === null) {
        sawDone = true
        continue
      }
      // 本帧承载完成原因，要先按原样处理；之后的越界帧才只吸收 usage。
      const completes = sawDone || sawFinish
      if (hasFinishReason(chunk)) sawFinish = true
      const normalized = normalizeChunk(completes ? usageOnly(chunk) : chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue

      if (!id && typeof normalized.id === "string") id = normalized.id
      if (created == null) created = normalized.created
      if (normalized.usage) usage = normalized.usage

      for (const choice of normalized.choices ?? []) {
        const index = Number.isInteger(choice.index) ? choice.index : 0
        if (!choices.has(index))
          choices.set(index, { role: "assistant", content: "", reasoning: "", calls: new Map(), extra: {} })
        const state = choices.get(index)
        const delta = choice.delta ?? {}
        if (typeof delta.role === "string" && delta.role) state.role = delta.role
        if (typeof delta.content === "string") state.content += delta.content
        if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content
        // 非流式必须把流式会透传的东西也带上，否则同一次上游调用在两种模式下结果不同。
        mergePassthrough(state, delta)
        for (const call of delta.tool_calls ?? []) {
          // 上游把并行调用放在各自独立的帧里，且常常不带 index。
          // 此时只有"参数续传"才该并入上一个调用；带新 id / 新函数名说明是另一个调用。
          const target = toolCallTarget(state, call)
          if (typeof call.id === "string" && call.id) target.id = call.id
          if (typeof call.function?.name === "string" && call.function.name) target.name = call.function.name
          if (typeof call.function?.arguments === "string") target.arguments += call.function.arguments
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) state.finish = choice.finish_reason
      }
    }
    if (client.closed) return
    // 只有 usage、连一个 choice 帧都没有：这是上游异常，不是"空回答"。
    if (!choices.size) throw new ZenStreamError("Empty response from upstream")
    // 仍缺 finish_reason = 流被打断，不能走到下面的 ?? "stop" 伪装成完整答案。
    if (!sawDone && !sawFinish && ![...choices.values()].every((state) => state.finish)) {
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
          // 流式会把未知字段原样透传，非流式也必须带上，否则两种模式结果不同。
          Object.assign(message, state.extra)
          return { index, message, finish_reason: normalizeFinish(state.finish ?? "stop", state.calls.size) }
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
