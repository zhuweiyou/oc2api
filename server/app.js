// Express app 组装：全局中间件 → 公开路由 → 受保护路由（路由级鉴权）→ 404/错误兜底。
// 由本地入口 server/index.js 与 Vercel 入口 api/index.js 共用。
import express from "express"

import { config } from "./config.js"
import { chat, health, ip, models } from "./handler.js"
import { cors, errorHandler, notFound, normalizeUrl, rawBody, requireAuth } from "./middleware.js"

export const app = express()
app.disable("x-powered-by")
app.use(normalizeUrl)
app.use(cors)

// 公开路由：无需鉴权
app.get(["/", "/health"], health)
app.get("/ip", ip)

// 受保护路由：路由级鉴权 + 原始体缓冲（GET 不读 body）
const api = express.Router()
api.get(["/v1/models", "/models"], requireAuth, models)
api.post(["/v1/chat/completions", "/chat/completions"], requireAuth, rawBody, chat)
app.use(api)

// 未注册路径直接 404，不经过鉴权
app.use(notFound)
app.use(errorHandler)

// 启动本地服务（npm start / 测试用）
export function startServer({ port = config.port, logger = console } = {}) {
  const server = app.listen(port, "0.0.0.0", () => {
    logger.log(`OC2API Express server running on http://localhost:${port}`)
  })
  return server
}

export default app
