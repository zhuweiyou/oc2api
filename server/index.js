// 本地启动入口：node server/index.js（npm start / Docker CMD）。
// 只做启动与优雅退出；app 与 startServer 定义在 server/app.js。
import { startServer } from "./app.js"

const server = startServer()
let shuttingDown = false

const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}, shutting down...`)
  const forceTimer = setTimeout(() => server.closeAllConnections?.(), 10_000)
  forceTimer.unref?.()
  server.close((error) => {
    clearTimeout(forceTimer)
    if (error) {
      console.error("Graceful shutdown failed:", error)
      process.exitCode = 1
    }
  })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
