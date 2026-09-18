import { pathToFileURL } from "node:url"

import app from "./app.js"

export function configuredPort(env = process.env) {
  const value = Number.parseInt(String(env.PORT || ""), 10)
  return Number.isInteger(value) && value > 0 ? value : 8080
}

export function startServer({ port = configuredPort(), logger = console } = {}) {
  const server = app.listen(port, "0.0.0.0", () => {
    logger.log(`OC2API Express server running on http://localhost:${port}`)
  })
  return server
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
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
}

export default app
