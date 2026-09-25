// 被 2 个以上功能文件共用的响应与解析工具。
// 单文件独用的方法不进这里，留在各自文件内部。

export function sendJson(res, data, status = 200, headers = {}) {
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.status(status).json(data)
}

export function openAIErrorResponse(res, message, type, status, code) {
  sendJson(res, { error: { message, type, ...(code ? { code } : {}) } }, status)
}

export function upstreamErrorResponse(res, error) {
  const timeout = error?.message === "timeout"
  const message = timeout ? "Upstream timeout" : `Upstream error: ${error?.message || error}`
  const type = timeout ? "timeout_error" : "upstream_error"
  const status = timeout ? 504 : 502
  openAIErrorResponse(res, message, type, status)
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function ocId(prefix) {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const rnd = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 16)
  return `${prefix}_${Date.now().toString(16)}${rnd}`
}
