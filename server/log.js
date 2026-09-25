// 调试日志：DEBUG=true 时输出请求/响应细节，错误日志始终输出。
import { config } from "./config.js"

export function debugLog(label, payload) {
  if (!config.debug) return
  console.log(label, JSON.stringify(payload))
}

export function logZenRequest(requestId, format, model, stream, user, zenReq, messageCount) {
  if (!config.debug) return
  debugLog("[ZEN REQ]", {
    requestId,
    format,
    user,
    model,
    stream: !!stream,
    messageCount,
    bodyBytes: byteLength(zenReq.body),
    ocRequest: shortId(zenReq.headers["x-opencode-request"]),
    ocSession: shortId(zenReq.headers["x-opencode-session"]),
  })
}

export function logZenResponse(payload) {
  const { status } = payload
  // 仅 DEBUG 开启或上游错误(>=400)时输出
  if (!config.debug && status < 400) return
  console.log("[ZEN RES]", JSON.stringify(payload))
}

export function logUpstreamBody(requestId, model, status, raw, zenError, firstChunk = false) {
  const body = String(raw || "")
  const shouldLog = config.debug || Boolean(zenError) || status >= 400
  if (!shouldLog) return

  const payload = { requestId, model, status, firstChunk, chars: body.length }
  if (zenError) payload.zenError = { message: zenError.message, type: zenError.type }
  if (shouldLog) payload.preview = previewText(body)

  console.log("[ZEN BODY]", JSON.stringify(payload))
}

function byteLength(text) {
  return new TextEncoder().encode(String(text || "")).length
}

function shortId(id) {
  const text = String(id || "")
  if (text.length <= 16) return text
  return `${text.slice(0, 8)}...${text.slice(-6)}`
}

function previewText(text, max = 800) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .slice(0, max)
}
