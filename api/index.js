// Vercel 薄层：只做路由、鉴权、SSE 翻译。
// 业务逻辑全部在 Go 二进制里，首次请求时 spawn（-stdio），用 JSON-RPC 按 id 分发。
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
  "Access-Control-Expose-Headers": "X-Request-Id, Retry-After, Retry-After-Ms",
}

const BIN_SOURCE = process.env.OC2API_BIN || `${process.cwd()}/bin/oc2api`
const BIN_PATH = "/tmp/oc2api-bin"

let child = null
const pending = new Map()
let nextId = 1

function ensureChild() {
  if (child && child.exitCode === null) return child
  fs.copyFileSync(BIN_SOURCE, BIN_PATH)
  fs.chmodSync(BIN_PATH, 0o755)
  child = spawn(BIN_PATH, ["-stdio"], { stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.on("data", (chunk) => console.error("[go]", chunk.toString().trim()))
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.method === "sse") {
      entry.onEvent?.("sse", message.params?.data ?? "")
      return
    }
    if (message.method === "end") {
      pending.delete(message.id)
      entry.resolve({ ended: true })
      return
    }
    if (message.error) {
      pending.delete(message.id)
      entry.reject(new Error(message.error.message || "rpc error"))
      return
    }
    pending.delete(message.id)
    entry.resolve(message.result)
  })
  child.on("exit", () => {
    child = null
    for (const [, entry] of pending) entry.reject(new Error("go core exited"))
    pending.clear()
  })
  child.stdin.on("error", () => {})
  return child
}

function rpcCall(method, params, onEvent) {
  const proc = ensureChild()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...CORS,
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

const errorPayload = (message, type, code) => ({
  error: { message, type, ...(code ? { code } : {}) },
})

function authorized(req) {
  const key = process.env.API_KEY
  if (!key) return true
  const header = req.headers.authorization || ""
  if (header.startsWith("Bearer ") && header.slice(7).trim() === key) return true
  return (req.headers["x-api-key"] || "").trim() === key
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const path = url.pathname.replace(/\/+$/, "") || "/"

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS)
    return res.end()
  }

  if (path === "/" || path === "/health") {
    try {
      const result = await rpcCall("health", {})
      return sendJson(res, 200, { ...result, runtime: "vercel-go-core" })
    } catch (error) {
      return sendJson(res, 503, errorPayload(String(error.message), "upstream_error"))
    }
  }

  if (path === "/ip") {
    return sendJson(res, 200, { ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null })
  }

  if (!["/v1/models", "/models", "/v1/chat/completions", "/chat/completions"].includes(path)) {
    return sendJson(res, 404, errorPayload("Not found", "invalid_request_error"))
  }

  if (!authorized(req)) {
    return sendJson(res, 401, errorPayload("Invalid API key", "authentication_error"))
  }

  if (path === "/v1/models" || path === "/models") {
    try {
      const result = await rpcCall("models", {})
      return sendJson(res, 200, result)
    } catch (error) {
      return sendJson(res, 502, errorPayload(String(error.message), "upstream_error", "upstream_error"))
    }
  }

  const raw = await readBody(req)
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return sendJson(res, 400, errorPayload("Invalid JSON body", "invalid_request_error"))
  }

  const stream = payload.stream === true
  if (!stream) {
    try {
      const result = await rpcCall("chat", { body: payload, stream: false })
      if (result?.status && result.status !== 200) {
        const headers = result.retryAfter ? { "Retry-After": result.retryAfter } : {}
        return sendJson(res, result.status, result.error, headers)
      }
      return sendJson(res, 200, result)
    } catch (error) {
      return sendJson(res, 502, errorPayload(String(error.message), "upstream_error", "upstream_stream_error"))
    }
  }

  res.writeHead(200, {
    ...CORS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  })
  try {
    await rpcCall("chat", { body: payload, stream: true }, (_event, data) => {
      res.write(data)
    })
  } catch {
    // 上游错误已在业务层处理，这里只保证连接收尾。
  }
  res.end()
}
