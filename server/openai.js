// OpenAI 兼容响应层：上游本就是 OpenAI 协议，这里只做最小必要改写
// （思考字段归一为 reasoning_content、剥掉 cost/delta.name、失败归一为 429），
// 不解析也不重组正文。上游只支持流式，非流式请求在这里把 SSE 聚合成 JSON。
//
// 完成语义有几处反直觉，改动前先看 tests/node/response.test.js：
//   - 所有 choice 的 finish_reason 或 [DONE] 表示完成；finish 后仍读 usage，空闲超时也算成功；
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
  if (!isPlainObject(delta)) return {}
  const next = { ...delta }
  if (next.tool_calls != null) {
    if (Array.isArray(next.tool_calls)) next.tool_calls = next.tool_calls.filter(isPlainObject)
    else delete next.tool_calls
  }

  // 上游私有扩展：下游 schema 里没有，原样透传会让严格客户端报错。
  delete next.name
  delete next.cost

  // 思考字段归一：reasoning 优先，reasoning_details 只是同一内容的镜像（实测一致）。
  let reasoning = ""
  if (typeof delta.reasoning === "string" && delta.reasoning) reasoning = delta.reasoning
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
  } else next.choices = []
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

// 流式侧就地改写 finish_reason：必须按 choice 追踪工具调用，否则 n>1 时
// 某个带工具的 choice 会把纯文本 choice 的 stop 一起改写成 tool_calls。
function rewriteFinishReason(chunk, toolCallChoiceIndexes) {
  for (const choice of chunk.choices ?? []) {
    if (!choice.finish_reason) continue
    const index = Number.isInteger(choice.index) ? choice.index : 0
    choice.finish_reason = normalizeFinish(choice.finish_reason, toolCallChoiceIndexes.has(index) ? 1 : 0)
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
  let formatDecided = false
  const choiceIndexes = new Set()
  const finishedIndexes = new Set()
  const expectedChoices = Number.isInteger(ctx.choiceCount) && ctx.choiceCount > 0 ? ctx.choiceCount : 1
  // 所有 choice 完成之后才开始尾段，不能让一个 choice 先结束就截断其余 choice。
  let trailingUntil = 0

  const beginTrailer = (done = false) => {
    // finish 后 usage / [DONE] 仍可能延迟到达，不能用 1s 抢跑丢掉统计。
    // 真正 [DONE] 后才缩短窗口；重复完成信号不延长总预算。
    const deadline = Date.now() + (done ? TRAILING_USAGE_TIMEOUT_MS : BODY_IDLE_TIMEOUT_MS)
    trailingUntil = trailingUntil ? Math.min(trailingUntil, deadline) : deadline
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
      beginTrailer(true)
      return null
    }
    const parsed = safeParse(event.payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // 尾段已经拿到过完成信号，回答是完整的：尾部残缺/垃圾不足以推翻它。
      if (trailing) return undefined
      throw new ZenStreamError("Invalid SSE payload from upstream")
    }
    const failure = upstreamError(parsed, event.type === "error")
    if (failure) {
      if (trailing) return undefined // 忽略不等于 [DONE]，不能伪造完成信号
      logUpstreamBody(ctx.requestId, ctx.model, ctx.status, event.payload, failure)
      throw new ZenStreamError(failure.message)
    }
    if (trailing) return parsed.usage ? { ...parsed, choices: [] } : undefined
    for (const choice of Array.isArray(parsed.choices) ? parsed.choices : []) {
      if (!isPlainObject(choice)) continue
      const index = Number.isInteger(choice.index) ? choice.index : 0
      choiceIndexes.add(index)
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finishedIndexes.add(index)
    }
    if (choiceIndexes.size >= expectedChoices && [...choiceIndexes].every((index) => finishedIndexes.has(index))) {
      beginTrailer()
    }
    return parsed
  }

  function* emit(event) {
    const chunk = parse(event)
    if (chunk === undefined) return
    const pausedAt = Date.now()
    yield chunk // 只有真正的 [DONE] 才产生 null
    // 消费者因下游背压暂停期间，不消耗上游读取的尾段预算。
    if (trailingUntil) trailingUntil += Math.max(0, Date.now() - pausedAt)
  }

  while (true) {
    // 空闲窗口只约束 reader.read() 等网络的时间，不含 yield 后等待下游 drain。
    let budget = sawAny ? BODY_IDLE_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS
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
    if (!result.done) sawAny = true
    buffer += text
    if (!formatDecided && buffer.trimStart()) {
      formatDecided = true
      // 免费层也可能用 HTTP 200 + 原始 JSON 报错；不能等整个 SSE 空闲窗口才识别。
      if (buffer.trimStart().startsWith("{")) {
        throw new ZenStreamError(await readError(reader, ctx, ctx.status, buffer, decoder))
      }
    }

    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event = readLine(line)
      if (!event) continue
      yield* emit(event)
    }

    if (result.done) {
      if (buffer) {
        const event = readLine(buffer)
        if (event) yield* emit(event)
      }
      const event = takeEvent()
      if (event) yield* emit(event)
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
  if (!upstream.body) return `Upstream returned HTTP ${upstream.status}`
  return readError(upstream.body.getReader(), ctx, upstream.status)
}

async function readError(reader, ctx, status, initialText = "", decoder = new TextDecoder()) {
  // 原始 JSON 检测移交时复用解码器，保留首网络块末尾挂起的 UTF-8 半字符。
  const initialBytes = new TextEncoder().encode(initialText)
  let text =
    initialBytes.byteLength <= 64 * 1024 ? initialText : new TextDecoder().decode(initialBytes.subarray(0, 64 * 1024))
  let read = Math.min(initialBytes.byteLength, 64 * 1024)
  // 只解析首段和最终正文两次，不对每个网络块反复 JSON.parse（避免 O(n²)）。
  const initialError = upstreamError(safeParse(text))
  const deadline = Date.now() + 1000
  while (!initialError && read < 64 * 1024) {
    const budget = deadline - Date.now()
    if (budget <= 0) break
    const step = await raceRead(reader, budget).catch(() => ({ done: true }))
    if (step.done) break
    const bytes = step.value.subarray(0, 64 * 1024 - read)
    text += decoder.decode(bytes, { stream: true })
    read += bytes.byteLength
  }
  text += decoder.decode()
  await reader.cancel().catch(() => {})
  logUpstreamBody(ctx.requestId, ctx.model, status, text, initialError)
  return initialError?.message || upstreamError(safeParse(text), true)?.message || `Upstream returned HTTP ${status}`
}

// ---- 对外两种响应模式 ----

// 统一的完成判定，两种响应模式共用，避免同输入在流式/非流式下结论相反：
//   - 一个 choice 都没有（只回了 usage）→ 上游异常；
//   - 有 choice 但没收到完成信号、且仍有 choice 缺 finish_reason → 截断；
//   - 其余（[DONE] 或所有 choice 都 finish）→ 正常完成。
function assertCompleted({ sawDone, choiceIndexes, finishedIndexes }) {
  if (!choiceIndexes.size) throw new ZenStreamError("Empty response from upstream")
  const allFinished = [...choiceIndexes].every((index) => finishedIndexes.has(index))
  if (!sawDone && !allFinished) {
    throw new ZenStreamError("Incomplete response from upstream")
  }
}

export async function respondStream(response, upstream, ctx) {
  if (!upstream.ok) return sendJson(response, rateLimitError(await readErrorBody(upstream, ctx)), 429)
  if (!upstream.body) return sendJson(response, rateLimitError("Empty response from upstream"), 429)

  const reader = upstream.body.getReader()
  const client = watchClose(response, reader)
  let started = false
  let sawDone = false
  // 出现过的 choice index、已收尾的 choice index：完成判定必须按 choice 而非全局，
  // 否则某个 choice 先 finish 会把其它 choice 后续的 finish 帧一并吞掉。
  const sawChoiceIndexes = new Set()
  const finishedChoiceIndexes = new Set()
  // 出现过工具调用的 choice index 集合：finish_reason 归一只应作用于这些 choice。
  const toolCallChoiceIndexes = new Set()
  // 每个 choice 独立维护上游调用身份与下游 index，映射只在本次请求内存在。
  const streamToolCalls = new Map()
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
      // 完成判定按 choice：n>1 时各 choice 可能分别在不同帧收尾，
      // 用全局布尔会把后收尾的 choice 整个吞掉。
      const normalized = normalizeChunk(chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue
      // 已收尾的 choice（含 [DONE] 之后的所有 choice）不再接收正文：
      // 上游补发的越界内容不能写进已结束的响应。
      const usableChoices = (normalized.choices ?? []).filter((choice) => {
        const index = Number.isInteger(choice.index) ? choice.index : 0
        return !sawDone && !finishedChoiceIndexes.has(index)
      })
      const usable = { ...normalized, choices: usableChoices }
      const hasChoices = usableChoices.length > 0
      // 上游结尾的 {choices:[],cost} 之类空帧没有转发价值；
      // 但带 usage 的帧即使没有可用 choice 也要转（补齐统计）。
      if (!hasChoices && !usable.usage) continue
      for (const choice of usableChoices) {
        const index = Number.isInteger(choice.index) ? choice.index : 0
        sawChoiceIndexes.add(index)
        // 工具调用帧总在 finish 帧之前到达，所以这里能判断出该不该改写 finish_reason。
        // 按 choice 追踪：n>1 时某个 choice 带工具，不代表其它 choice 也带。
        if (choice.delta?.tool_calls?.length) {
          toolCallChoiceIndexes.add(index)
          if (!streamToolCalls.has(index)) {
            streamToolCalls.set(index, { calls: newCallState(), indexes: new Set(), nextIndex: 0 })
          }
          choice.delta.tool_calls = normalizeStreamToolCalls(choice.delta.tool_calls, streamToolCalls.get(index))
        }
        if (choice.finish_reason) finishedChoiceIndexes.add(index)
      }
      rewriteFinishReason(usable, toolCallChoiceIndexes)

      if (!hasContent(usable) && !started && pending.length < MAX_PENDING_FRAMES) {
        pending.push(usable)
        continue
      }
      // 首个正文或达到上限：先按序排空旧帧，再写新帧；一旦输出不再重新缓冲。
      for (const buffered of pending.splice(0)) await send(buffered)
      await send(usable)
      if (client.closed) break
    }
    if (client.closed) return
    // 与流式共用同一判定：无完成信号即截断，不能补 [DONE] 伪装成正常完成；
    // 但"明确完成的空回答"算成功（对齐 opencode 官方）。
    assertCompleted({ sawDone, choiceIndexes: sawChoiceIndexes, finishedIndexes: finishedChoiceIndexes })
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

// 复用非流式的调用身份判定，但不聚合参数：每个片段仍立即发送。
// 下游 index 一旦发出就不能变；后到的真实 index 只用于定位同一个 target。
// 标准 indexed 流保留原值；若它与已发出的自动 index 碰撞，则分配空闲值，
// 后续片段始终沿用 target.streamIndex，不能把两个调用交给客户端并到一处。
function normalizeStreamToolCalls(calls, state) {
  return calls.map((call) => {
    const target = toolCallTarget(state.calls, call)
    if (typeof call.id === "string" && call.id) {
      target.id = call.id
      state.calls.callsById.set(call.id, target)
    }
    if (target.streamIndex === undefined) {
      const canKeepIndex = Number.isSafeInteger(call.index) && call.index >= 0 && !state.indexes.has(call.index)
      target.streamIndex = canKeepIndex ? call.index : state.nextIndex
      state.indexes.add(target.streamIndex)
      while (state.indexes.has(state.nextIndex)) state.nextIndex++
    }
    return { ...call, index: target.streamIndex }
  })
}

// 找到该 tool_call 增量应并入的槽位（新建或续传）。
// 上游的并行调用常常不带 index（实测 10 轮里 12/36 帧如此），所以不能只按 index 归并：
//   - 带 index：按 index 归档；无 index 的首帧通过 id / 隐式序号绑定并迁移槽位；
//   - 不带 index 但 id 已出现：按 id 归并，允许其它调用插入其间；
//   - 不带 index 且带新 id / 函数名：新建槽位；
//   - 不带 index 且只有 arguments（参数续传）：并入当前正在累积的调用。
// 自动槽位用 "auto:N" 这类字符串键，避免与上游真正的数字 index 撞键。
function toolCallTarget(state, call) {
  const identified = state.callsById.get(call.id)
  if (Number.isInteger(call.index)) {
    let target = state.calls.get(call.index)
    if (!target && identified && typeof identified.slot === "string") target = identified
    if (!target) {
      // 无 index 首帧的创建序号对应 main 的隐式槽位；后来带 index 的续传可绑定它。
      // 真正的新 id 不能撞掉旧自动槽位；无 id 时按 index 续传，name 可晚到或补全。
      const candidate = state.unindexedCalls.get(call.index)
      const id = typeof call.id === "string" ? call.id : ""
      if (candidate && (!id || !candidate.id)) target = candidate
    }
    if (!target) target = newToolCall(state)
    if (target.slot !== call.index) bindCallIndex(state, target, call.index)
    state.currentCall = target
    return target
  }
  if (identified) {
    state.currentCall = identified
    return identified
  }
  const startsNew =
    (typeof call.id === "string" && call.id) || (typeof call.function?.name === "string" && call.function.name)
  if (!startsNew && state.currentCall) return state.currentCall
  const target = newToolCall(state)
  target.slot = `auto:${state.autoKeys++}`
  state.calls.set(target.slot, target)
  state.unindexedCalls.set(target.order, target)
  state.currentCall = target
  return target
}

function bindCallIndex(state, target, index) {
  if (typeof target.slot === "string") {
    state.calls.delete(target.slot)
    state.unindexedCalls.delete(target.order)
  }
  target.slot = index
  state.calls.set(index, target)
}

function newToolCall(state) {
  // order 记录创建顺序，输出时据此排序（键可能是数字 index，也可能是 auto:N 字符串）。
  return { id: "", name: "", arguments: "", order: state.nextOrder++, slot: null }
}

function orderedToolCalls(state) {
  const entries = [...state.calls.entries()]
  // 标准 indexed 流按 index 还原顺序（与 main 一致）；混合无 index 流才保留到达顺序。
  if (entries.every(([index]) => Number.isInteger(index))) entries.sort(([a], [b]) => a - b)
  else entries.sort(([, a], [, b]) => a.order - b.order)
  return entries.map(([, call]) => call)
}

function newCallState() {
  return {
    role: "assistant",
    content: "",
    reasoning: "",
    calls: new Map(),
    callsById: new Map(),
    unindexedCalls: new Map(),
    extra: {},
    currentCall: null,
    nextOrder: 0,
    autoKeys: 0,
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
      // 完成信号之后只吸收 usage；判定按 choice，避免某个 choice 先收尾
      // 就把其它 choice 后续的 finish_reason 丢掉（会被下面的 ?? "stop" 掩盖）。
      const normalized = normalizeChunk(chunk, ctx.model, ctx.thinkingEnabled)
      if (!normalized) continue

      if (!id && typeof normalized.id === "string") id = normalized.id
      if (created == null) created = normalized.created
      if (normalized.usage) usage = normalized.usage

      for (const choice of normalized.choices ?? []) {
        const index = Number.isInteger(choice.index) ? choice.index : 0
        // 已收尾的 choice：后续越界帧（例如 [DONE] 之后补发的正文）不再并进结果。
        if (sawDone || choices.get(index)?.finish) continue
        if (!choices.has(index)) choices.set(index, newCallState())
        const state = choices.get(index)
        const delta = choice.delta ?? {}
        if (typeof delta.role === "string" && delta.role) state.role = delta.role
        if (typeof delta.content === "string") state.content += delta.content
        if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content
        // 非流式必须把流式会透传的东西也带上，否则同一次上游调用在两种模式下结果不同。
        mergePassthrough(state, delta)
        for (const call of delta.tool_calls ?? []) {
          const target = toolCallTarget(state, call)
          if (typeof call.id === "string" && call.id) {
            target.id = call.id
            state.callsById.set(call.id, target)
          }
          if (typeof call.function?.name === "string" && call.function.name) target.name = call.function.name
          if (typeof call.function?.arguments === "string") target.arguments += call.function.arguments
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) state.finish = choice.finish_reason
      }
    }
    if (client.closed) return
    // 与流式共用同一判定，避免同输入在两种模式下结论相反。
    assertCompleted({
      sawDone,
      choiceIndexes: new Set(choices.keys()),
      finishedIndexes: new Set([...choices.entries()].filter(([, state]) => state.finish).map(([index]) => index)),
    })

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
            message.tool_calls = orderedToolCalls(state).map((call) => ({
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
