// OpenAI 兼容响应转换：非流式聚合、SSE 流式转发（直写 Node res）、
// 流归一化与 think 块剥离。
import { openAIErrorResponse, safeJsonParse } from "./shared.js"
import { logUpstreamBody } from "./log.js"

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

// 上游任何错误都归一为 429：下游账号池工具(CLIProxyAPI/sub2api/new-api) 依赖 429 切换账号。
function rateLimitResponse(res, zenError) {
  return openAIErrorResponse(
    res,
    `${zenError?.message || "Rate limit exceeded"} (free model rate limit)`,
    "rate_limit_error",
    429,
    "rate_limit_exceeded",
  )
}

export async function openAIFullStreamResponse(res, upstream, requestId, model, thinkingEnabled) {
  const raw = await upstream.text()
  const zenError = parseZenError(raw)
  logUpstreamBody(requestId, model, upstream.status, raw, zenError)
  if (upstream.status >= 400 || zenError) return rateLimitResponse(res, zenError)

  const normalizer = createOpenAIStreamNormalizer(model, thinkingEnabled)
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
          reasoning: "",
          toolCalls: new Map(),
        })
      }
      const state = choices.get(index)
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {}
      if (typeof delta.role === "string" && delta.role) state.role = delta.role
      if (typeof delta.content === "string") state.content += delta.content
      if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content
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
      if (state.reasoning) message.reasoning_content = state.reasoning
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

  res.setHeader("x-request-id", requestId)
  res.status(upstream.status).json(result)
}

export async function openAIStreamResponse(res, upstream, requestId, model, thinkingEnabled) {
  if (!upstream.body) {
    return openAIErrorResponse(res, "Empty response from upstream", "upstream_error", 502)
  }

  const reader = upstream.body.getReader()
  const first = await reader.read()
  if (first.done) {
    return openAIErrorResponse(res, "Empty response from upstream", "upstream_error", 502)
  }

  const firstText = new TextDecoder().decode(first.value)
  const zenError = parseZenError(firstText)
  logUpstreamBody(requestId, model, upstream.status, firstText, zenError, true)
  if (upstream.status === 429 || zenError) {
    await reader.cancel().catch(() => {})
    return rateLimitResponse(res, zenError)
  }

  const decoder = new TextDecoder()
  const normalizer = createOpenAIStreamNormalizer(model, thinkingEnabled)

  res.status(upstream.status)
  for (const [key, value] of Object.entries(SSE_HEADERS)) res.setHeader(key, value)
  res.setHeader("x-request-id", requestId)
  res.flushHeaders()

  let buffer = ""
  let doneSent = false
  let closed = false
  res.on("close", () => {
    closed = true
    reader.cancel().catch(() => {})
  })

  // 串行化写入：write 返回 false 时等待 drain，保证背压生效且顺序不乱。
  let pending = Promise.resolve()
  const writeToRes = (text) => {
    if (closed || res.writableEnded) return
    if (res.write(text)) return
    pending = pending.then(
      () =>
        new Promise((resolve) => {
          if (closed || res.writableEnded) return resolve()
          const done = () => {
            res.off("drain", done)
            res.off("close", done)
            resolve()
          }
          res.once("drain", done)
          res.once("close", done)
        }),
    )
  }
  const sendData = (payload) =>
    writeToRes(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
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
    while (!doneSent && !closed) {
      const { done, value } = await reader.read()
      if (done) break
      processChunk(value)
    }

    const tail = decoder.decode()
    if (tail) buffer += tail
    if (buffer) processLine(buffer)
    if (doneSent) await reader.cancel().catch(() => {})
    sendDone()
    await pending
  } finally {
    await pending
    if (!closed && !res.writableEnded) res.end()
  }
}

export function createOpenAIStreamNormalizer(model, thinkingEnabled) {
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
      next.choices = chunk.choices
        .map((choice) => normalizeOpenAIStreamChoice(choice, contentStates, thinkingEnabled))
        .filter(Boolean)

      if (!next.choices.length && !next.usage) return null
      return next
    },
  }
}

function normalizeOpenAIStreamChoice(choice, contentStates, thinkingEnabled) {
  if (!choice?.delta) return choice

  const delta = { ...choice.delta }
  const thinking = thinkingEnabled !== false
  let strippedReasoning = ""

  if (typeof delta.content === "string") {
    const state = getThinkState(contentStates, choice.index ?? 0)
    const result = stripThinkStreamText(delta.content, state)
    const visibleContent = result.content
    strippedReasoning = result.reasoning
    if (visibleContent) delta.content = visibleContent
    else delete delta.content
  }

  if (thinking) {
    // 开启思考：上游 reasoning / reasoning_content 统一归一为 OpenAI 兼容的
    // reasoning_content，内容中被剥离的 think 块一并并入。
    const fragments = []
    if (typeof delta.reasoning === "string" && delta.reasoning) fragments.push(delta.reasoning)
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) fragments.push(delta.reasoning_content)
    delete delta.reasoning
    if (strippedReasoning) fragments.push(strippedReasoning)
    if (fragments.length) delta.reasoning_content = fragments.join("")
  } else {
    // 关闭思考：丢弃所有思考痕迹。
    delete delta.reasoning
    delete delta.reasoning_content
  }

  if (!Object.keys(delta).length && !choice.finish_reason) return null
  return { ...choice, delta }
}

export function stripThinkBlocks(text) {
  if (!/<\/?think(?:ing)?>/i.test(text) && !text.toLowerCase().includes(" thinking")) return text
  const state = createThinkState()
  return stripThinkStreamText(text, state).content
}

function getThinkState(states, key) {
  const stateKey = String(key)
  if (!states.has(stateKey)) states.set(stateKey, createThinkState())
  return states.get(stateKey)
}

function createThinkState() {
  return { inThink: false, emittedContent: false, removedThink: false, reasoning: "" }
}

function stripThinkStreamText(text, state) {
  let output = ""
  let cursor = 0

  while (cursor < text.length) {
    if (state.inThink) {
      const close = findThinkClose(text, cursor)
      if (close.index === -1) {
        // 思考块未闭合（流式中途截断）：剩余全部算思考
        state.reasoning += text.slice(cursor)
        break
      }
      state.reasoning += text.slice(cursor, close.index)
      cursor = close.end
      state.inThink = false
      state.removedThink = true
      continue
    }

    const open = findThinkOpen(text, cursor)
    if (open.index === -1) {
      output += text.slice(cursor)
      break
    }

    output += text.slice(cursor, open.index)
    cursor = open.end
    state.inThink = true
    state.removedThink = true
  }

  if (state.removedThink && !state.emittedContent && output) output = output.replace(/^\s+/, "")
  if (output) state.emittedContent = true
  return { content: output, reasoning: state.reasoning }
}

function findThinkOpen(text, from) {
  // 兼容 <thinking> 与 <think> 两种标签，以及 " thinking" 空格标记
  const tag = text.indexOf("<thinking", from)
  const short = tag === -1 ? text.indexOf("<think", from) : -1
  const openIdx = tag !== -1 ? tag : short
  if (openIdx !== -1) {
    const word = tag !== -1 ? "<thinking" : "<think"
    // 跳过标签名后的可选空白与 '>'
    let end = openIdx + word.length
    if (text[end] === ">") end += 1
    return { index: openIdx, end }
  }
  const marker = text.indexOf(" thinking", from)
  if (marker !== -1) {
    return { index: marker, end: marker + " thinking".length }
  }
  return { index: -1, end: -1 }
}

function findThinkClose(text, from) {
  // 兼容 </thinking> 与 </think> 两种标签，以及 " response" 空格标记
  let tag = text.indexOf("</thinking", from)
  let word = "</thinking"
  if (tag === -1) {
    tag = text.indexOf("</think", from)
    word = "</think"
  }
  if (tag !== -1) {
    const after = text.indexOf(">", tag)
    return { index: tag, end: after === -1 ? tag + word.length : after + 1 }
  }
  const marker = text.indexOf(" response", from)
  if (marker !== -1) {
    return { index: marker, end: marker + " response".length }
  }
  return { index: -1, end: -1 }
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
