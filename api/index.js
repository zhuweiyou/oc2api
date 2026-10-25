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
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.method === "sse") {
      entry.onEvent?.(message.params?.data ?? "")
      return
    }
    if (message.method === "end") {
      pending.delete(message.id)
      entry.resolve({ type: "end" })
      return
    }
    if (message.error) {
      pending.delete(message.id)
      entry.resolve({ type: "rpc_error", error: message.error.message || "rpc error" })
      return
    }
    pending.delete(message.id)
    entry.resolve({ type: "result", value: message.result })
  })
  child.on("exit", () => {
    child = null
    for (const [, entry] of pending) entry.resolve({ type: "rpc_error", error: "go core exited" })
    pending.clear()
  })
  child.stdin.on("error", () => {})
  return child
}

function rpcCall(method, params, onEvent) {
  const proc = ensureChild()
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve, onEvent })
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

// 与 Node 版 authenticate 等价：authorization 优先，回退 x-api-key；
// 带不带 "Bearer " 前缀都接受，比较的是去掉前缀后的原始 token。
function authorized(req) {
  const key = process.env.API_KEY
  if (!key) return true
  const header = req.headers.authorization || req.headers["x-api-key"] || ""
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim()
  return token === key
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

async function rpcJson(req, res, method, params) {
  const outcome = await rpcCall(method, params)
  if (outcome.type !== "result") {
    return sendJson(res, 503, errorPayload(outcome.error || "go core unavailable", "upstream_error"))
  }
  if (typeof outcome.value?.status === "number" && outcome.value.status !== 200) {
    const headers = outcome.value.retryAfter ? { "Retry-After": outcome.value.retryAfter } : {}
    return sendJson(res, outcome.value.status, outcome.value.error, headers)
  }
  return sendJson(res, 200, outcome.value)
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const path = url.pathname.replace(/\/+$/, "") || "/"

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS)
    return res.end()
  }

  if (path === "/" || path === "/health") return rpcJson(req, res, "health", {}, 503)
  if (path === "/ip") return rpcJson(req, res, "ip", {})

  if (!["/v1/models", "/models", "/v1/chat/completions", "/chat/completions"].includes(path)) {
    return sendJson(res, 404, errorPayload("Not found", "invalid_request_error"))
  }

  if (!authorized(req)) {
    return sendJson(res, 401, errorPayload("Invalid API key", "authentication_error"))
  }

  if (path === "/v1/models" || path === "/models") return rpcJson(req, res, "models", {})

  const raw = await readBody(req)
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return sendJson(res, 400, errorPayload("Invalid JSON body", "invalid_request_error"))
  }
  if (payload?.stream !== true) {
    return rpcJson(req, res, "chat", { body: payload, stream: false })
  }

  // 流式：先等第一条消息，确认不是校验错误再提交 SSE 响应头。
  let started = false
  const outcome = await rpcCall("chat", { body: payload, stream: true }, (data) => {
    if (!started) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      })
      started = true
    }
    res.write(data)
  })

  if (!started) {
    if (outcome.type === "result" && typeof outcome.value?.status === "number" && outcome.value.status !== 200) {
      const headers = outcome.value.retryAfter ? { "Retry-After": outcome.value.retryAfter } : {}
      return sendJson(res, outcome.value.status, outcome.value.error, headers)
    }
    return sendJson(res, 502, errorPayload(outcome.error || "upstream stream error", "upstream_error"))
  }
  res.end()
}
