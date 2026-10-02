import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import { startServer } from "../../server/app.js"

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

test("local streaming tools declared but not selectable", liveTestOptions(), async (t) => {
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

test("Vercel streaming tools declared but not selectable", liveTestOptions(), async (t) => {
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

test("local streaming actually invokes a custom tool", liveTestOptions(), async (t) => {
  const invoked = await invokeToolWithRetry(t, localURL)
  if (!invoked) {
    t.skip("upstream declined to call the tool across all attempts")
    return
  }

  const { chunks, call } = invoked
  assert.equal(call.name, "get_weather")
  assert.ok(call.id, "tool call must carry an id so the client can answer it")
  assert.deepEqual(JSON.parse(call.arguments), { city: "Tokyo" })
  assert.equal(
    chunks.flatMap((chunk) => chunk.choices).find((choice) => choice.finish_reason)?.finish_reason,
    "tool_calls",
  )
})

test("local tool result round-trip completes the conversation", liveTestOptions(), async (t) => {
  // 完整 agent 循环：模型调用工具 -> 客户端回填 tool 结果 -> 模型基于结果作答。
  const invoked = await invokeToolWithRetry(t, localURL)
  if (!invoked) {
    t.skip("upstream declined to call the tool across all attempts")
    return
  }

  const first = invoked.call
  const assistantText =
    invoked.chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice) => choice.delta?.content ?? "")
      .join("") || null

  const response = await runOrSkip(t, () =>
    requestChat(localURL, {
      stream: true,
      messages: [
        { role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." },
        {
          role: "assistant",
          content: assistantText,
          tool_calls: [{ id: first.id, type: "function", function: { name: first.name, arguments: first.arguments } }],
        },
        {
          role: "tool",
          tool_call_id: first.id,
          content: '{"city":"Tokyo","temp_c":18,"condition":"cloudy"}',
        },
      ],
      tools: [weatherTool()],
      tool_choice: "auto",
      max_tokens: 256,
    }),
  )
  if (!response) return

  const chunks = parseSSEData(response.text, "round-trip step 2")
  const text = chunks
    .flatMap((chunk) => chunk.choices)
    .map((choice) => choice.delta?.content ?? "")
    .join("")
  assert.ok(text.length > 0, "模型应基于工具结果给出回答")
  assert.equal(collectToolCalls(chunks).name, "", "拿到结果后不应再次调用工具")
})

test("Vercel streaming actually invokes a custom tool", liveTestOptions(), async (t) => {
  const invoked = await invokeToolWithRetry(t, vercelURL)
  if (!invoked) {
    t.skip("upstream declined to call the tool across all attempts")
    return
  }

  const { call } = invoked
  assert.equal(call.name, "get_weather")
  assert.deepEqual(JSON.parse(call.arguments), { city: "Tokyo" })
})

test("local non-stream also invokes a custom tool", liveTestOptions(), async (t) => {
  // 上游只支持流式，非流式靠代理聚合；工具调用必须能在聚合后还原。
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await runOrSkip(t, () =>
      requestChat(localURL, {
        stream: false,
        messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
        tools: [weatherTool()],
        tool_choice: "auto",
        max_tokens: 256,
      }),
    )
    if (!response) return

    const body = parseJSON(response.text, `non-stream tool invocation attempt ${attempt}`)
    const choice = body.choices[0]
    const call = choice.message.tool_calls?.[0]
    if (!call) continue // 模型这次没调用，换一次再试

    assert.equal(choice.finish_reason, "tool_calls")
    assert.equal(call.type, "function")
    assert.ok(call.id, "tool call must carry an id")
    assert.equal(call.function.name, "get_weather")
    assert.deepEqual(JSON.parse(call.function.arguments), { city: "Tokyo" })
    return
  }
  t.skip("upstream declined to call the tool across all attempts")
})

function liveTestOptions() {
  return { skip: !live, concurrency: false }
}

/**
 * 模型是否调用工具由上游自主决定（tool_choice:"auto"），偶发不调用不算代理的错。
 * 用同一请求重试几次拿到调用结果；始终没有则返回空调用，由调用方决定 skip。
 * 注意仍然是真实断言：只要拿到调用，就断言 id / name / arguments 全部正确。
 */
async function invokeToolWithRetry(t, baseURL, { attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await runOrSkip(t, () =>
      requestChat(baseURL, {
        stream: true,
        messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
        tools: [weatherTool()],
        tool_choice: "auto",
        max_tokens: 256,
      }),
    )
    if (!response) return null
    const chunks = parseSSEData(response.text, `tool invocation attempt ${attempt}`)
    const call = collectToolCalls(chunks)
    if (call.name) return { response, chunks, call }
  }
  return null
}

/** 把同一 index 的 tool_calls 增量拼成完整调用（流式分片可能跨多个 chunk）。 */
function collectToolCalls(chunks) {
  const merged = new Map()
  for (const part of chunks.flatMap((chunk) => chunk.choices).flatMap((choice) => choice.delta?.tool_calls ?? [])) {
    const index = part.index ?? 0
    if (!merged.has(index)) merged.set(index, { id: "", name: "", arguments: "" })
    const call = merged.get(index)
    if (part.id) call.id = part.id
    if (part.function?.name) call.name = part.function.name
    if (part.function?.arguments) call.arguments += part.function.arguments
  }
  return merged.get(0) ?? { id: "", name: "", arguments: "" }
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
