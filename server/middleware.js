// 请求中间件：URL 归一化、CORS（cors 库）、原始体缓冲、路由级鉴权与错误兜底。
import corsLib from "cors"

import { readApiKey } from "./config.js"
import { openAIErrorResponse, sendJson } from "./shared.js"

// 允许的方法/请求头列表须与既有部署一致，故显式配置而不是用库默认值。
export const cors = corsLib({
  origin: "*",
  methods: "GET, POST, OPTIONS",
  allowedHeaders: "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
  exposedHeaders: "X-Request-Id",
  optionsSuccessStatus: 204,
})

// 与旧行为一致：剥掉全部尾部斜杠（/health// 也算 /health），查询串保留。
export function normalizeUrl(request, _response, next) {
  const url = request.url || "/"
  const queryIndex = url.indexOf("?")
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const search = queryIndex === -1 ? "" : url.slice(queryIndex)
  const trimmed = pathname.replace(/\/+$/, "")
  request.url = (trimmed || "/") + search
  next()
}

// 缓冲请求原始流，无大小限制（不能用 express.json 的默认 100kb）。
export function rawBody(request, _response, next) {
  if (request.rawBody !== undefined) return next()
  if (request.body !== undefined && request.body !== null) {
    request.rawBody =
      typeof request.body === "string" || Buffer.isBuffer(request.body) || request.body instanceof Uint8Array
        ? request.body
        : JSON.stringify(request.body)
    return next()
  }

  const chunks = []
  request
    .on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk))
    .on("end", () => {
      request.rawBody = Buffer.concat(chunks)
      next()
    })
    .on("error", next)
}

// 路由级鉴权：只挂在受保护路由上，未注册路径直接 404、不经过这里。
export function requireAuth(request, response, next) {
  const auth = authenticate(request)
  if (auth.error) {
    response.status(auth.error.status).json(auth.error.body)
    return
  }
  request.auth = auth
  next()
}

function authenticate(request) {
  const apiKey = readApiKey()
  if (!apiKey) return { user: "anonymous" }

  const header = request.headers.authorization || request.headers["x-api-key"] || ""
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim()

  if (token === apiKey) return { user: "user-default" }

  return {
    error: {
      status: 401,
      body: { error: { message: "Invalid API key", type: "authentication_error" } },
    },
  }
}

export function notFound(_request, response) {
  sendJson(response, { error: { message: "Not found" } }, 404)
}

export function errorHandler(error, _request, response, next) {
  console.log("[FUNCTION ERROR]", error?.stack || error?.message || error)
  if (response.headersSent) {
    next(error)
    return
  }
  openAIErrorResponse(response, "Internal error", "server_error", 500)
}
