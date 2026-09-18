import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import { startServer } from "../../server/index.js"

const live = process.env.OC2API_LIVE_TEST === "1"

let localServer
let vercelServer
let localURL
let vercelURL
let localFirstContent = "hi"
let vercelFirstContent = "hi"
let liveUnavailableMessage = ""

class LiveUnavailable extends Error {}

test.before(async () => {
  if (!live) return

  localServer = startServer({ port: 0, logger: { log() {} } })
  await once(localServer, "listening")
  localURL = `http://127.0.0.1:${localServer.address().port}`

  vercelServer = createServer(vercelApp)
  vercelServer.listen(0, "127.0.0.1")
  await once(vercelServer, "listening")
  vercelURL = `http://127.0.0.1:${vercelServer.address().port}`
})

test.after(async () => {
  if (localServer) await close(localServer)
  if (vercelServer) await close(vercelServer)
})

test("local non-stream hi", liveTestOptions(), async (t) => {
  const response = await runOrSkip(t, () =>
    requestChat(localURL, {
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  )
  if (!response) return

  const body = parseJSON(response.text, "local non-stream hi")
  assert.ok(Array.isArray(body.choices) && body.choices.length > 0, "local non-stream response has no choices")
  localFirstContent = body.choices[0]?.message?.content || "hi"
})

test("local streaming tools conversation", liveTestOptions(), async (t) => {
  const response = await runOrSkip(t, () =>
    requestChat(localURL, {
      stream: true,
      messages: conversationMessages(localFirstContent),
      tools: [weatherTool()],
      tool_choice: "none",
    }),
  )
  if (!response) return

  assertStreamingResponse(response.text, "local tools conversation")
})

test("Vercel non-stream hi", liveTestOptions(), async (t) => {
  const response = await runOrSkip(t, () =>
    requestChat(vercelURL, {
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  )
  if (!response) return

  const body = parseJSON(response.text, "Vercel non-stream hi")
  assert.ok(Array.isArray(body.choices) && body.choices.length > 0, "Vercel non-stream response has no choices")
  vercelFirstContent = body.choices[0]?.message?.content || "hi"
})

test("Vercel streaming tools conversation", liveTestOptions(), async (t) => {
  const response = await runOrSkip(t, () =>
    requestChat(vercelURL, {
      stream: true,
      messages: conversationMessages(vercelFirstContent),
      tools: [weatherTool()],
      tool_choice: "none",
    }),
  )
  if (!response) return

  assertStreamingResponse(response.text, "Vercel tools conversation")
})

function liveTestOptions() {
  return { skip: !live, concurrency: false }
}

async function runOrSkip(t, request) {
  if (liveUnavailableMessage) {
    t.skip(liveUnavailableMessage)
    return null
  }

  try {
    return await request()
  } catch (error) {
    if (!(error instanceof LiveUnavailable)) throw error
    liveUnavailableMessage = error.message
    t.skip(error.message)
    return null
  }
}

function conversationMessages(assistantContent) {
  return [
    { role: "user", content: "hi" },
    { role: "assistant", content: assistantContent || "hi" },
    { role: "user", content: "reply briefly with hi again" },
  ]
}

function assertStreamingResponse(text, scenario) {
  assert.match(text, /data:/, `${scenario} should contain SSE data`)
  assert.match(text, /\[DONE\]/, `${scenario} should terminate with [DONE]`)
  assert.ok(parseSSEData(text, scenario).length > 0, `${scenario} has no JSON chunks`)
}

async function requestChat(baseURL, payload) {
  const headers = { "content-type": "application/json" }
  if (process.env.API_KEY) headers.authorization = `Bearer ${process.env.API_KEY}`

  const response = await fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "big-pickle", max_tokens: 64, temperature: 0, ...payload }),
  })
  const text = await response.text()
  if (response.status === 429) {
    throw new LiveUnavailable(`big-pickle upstream is rate limited: ${text.trim()}`)
  }
  assert.equal(response.status, 200, `big-pickle request failed with HTTP ${response.status}: ${text}`)
  return { headers: response.headers, text }
}

function parseJSON(text, scenario) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${scenario} returned invalid JSON: ${error.message}; body=${text}`, { cause: error })
  }
}

function parseSSEData(text, scenario) {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim(),
    )
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => parseJSON(payload, scenario))
}

function weatherTool() {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  }
}

async function close(server) {
  if (!server.listening) return
  server.close()
  await once(server, "close")
}
