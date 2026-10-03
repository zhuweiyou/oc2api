import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import { startServer } from "../../server/app.js"

const live = process.env.OC2API_LIVE_TEST === "1"
const options = { skip: !live, concurrency: false, timeout: 120_000 }
let localServer
let vercelServer
let localURL
let vercelURL
let localFirstContent = "hi"
let vercelFirstContent = "hi"

test.before(async () => {
  if (!live) return
  localServer = startServer({ port: 0, logger: { log() {} } })
  await once(localServer, "listening")
  localURL = `http://127.0.0.1:${localServer.address().port}`
  // 验证 Vercel 入口的本地 HTTP 行为，不冒充远程 Vercel 部署验收。
  vercelServer = createServer(vercelApp)
  vercelServer.listen(0, "127.0.0.1")
  await once(vercelServer, "listening")
  vercelURL = `http://127.0.0.1:${vercelServer.address().port}`
})

test.after(async () => {
  if (localServer) await close(localServer)
  if (vercelServer) await close(vercelServer)
})

test("local non-stream hi", options, async () => {
  const response = await requestChat(localURL, { stream: false, messages: [{ role: "user", content: "hi" }] })
  const body = parseJSON(response.text, "local non-stream hi")
  localFirstContent = body.choices[0]?.message?.content
  assert.ok(localFirstContent?.length > 0, "应得到实际正文，而不只是空 choice")
  assert.ok(body.usage?.total_tokens > 0, "应有 token 统计")
})

test("local streaming tools declared but not selectable", options, async () => {
  const response = await requestChat(localURL, {
    stream: true,
    messages: conversationMessages(localFirstContent),
    tools: [weatherTool()],
    tool_choice: "none",
  })
  const chunks = assertStreamingResponse(response.text, "local tools conversation")
  assert.equal(collectToolCalls(chunks).length, 0, "tool_choice:none 不能产生工具调用")
})

test("Vercel entry non-stream hi", options, async () => {
  const response = await requestChat(vercelURL, { stream: false, messages: [{ role: "user", content: "hi" }] })
  const body = parseJSON(response.text, "Vercel entry non-stream hi")
  vercelFirstContent = body.choices[0]?.message?.content
  assert.ok(vercelFirstContent?.length > 0)
  assert.ok(body.usage?.total_tokens > 0)
})

test("Vercel entry streaming tools declared but not selectable", options, async () => {
  const response = await requestChat(vercelURL, {
    stream: true,
    messages: conversationMessages(vercelFirstContent),
    tools: [weatherTool()],
    tool_choice: "none",
  })
  const chunks = assertStreamingResponse(response.text, "Vercel entry tools conversation")
  assert.equal(collectToolCalls(chunks).length, 0)
})

test("local streaming actually invokes a custom tool", options, async () => {
  const { chunks, calls } = await invokeToolWithRetry(localURL)
  assertWeatherCall(calls[0], "Tokyo")
  assert.equal(calls.length, 1)
  assert.equal(
    chunks.flatMap((chunk) => chunk.choices).find((choice) => choice.finish_reason)?.finish_reason,
    "tool_calls",
  )
})

test("local tool result round-trip completes the conversation", options, async () => {
  const { chunks, calls } = await invokeToolWithRetry(localURL)
  calls.forEach((call) => assertWeatherCall(call, "Tokyo"))
  const assistantText =
    chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice) => choice.delta?.content ?? "")
      .join("") || null
  const response = await requestChat(localURL, {
    stream: true,
    messages: [
      { role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." },
      {
        role: "assistant",
        content: assistantText,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
      ...calls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: '{"city":"Tokyo","temp_c":18,"condition":"cloudy"}',
      })),
    ],
    tools: [weatherTool()],
    tool_choice: "auto",
  })
  const second = assertStreamingResponse(response.text, "round-trip step 2")
  const text = second
    .flatMap((chunk) => chunk.choices)
    .map((choice) => choice.delta?.content ?? "")
    .join("")
  assert.ok(text.length > 0, "模型应基于工具结果给出回答")
  assert.equal(collectToolCalls(second).length, 0, "拿到结果后不应再次调用工具")
})

test("Vercel entry streaming actually invokes a custom tool", options, async () => {
  const { calls } = await invokeToolWithRetry(vercelURL)
  assert.equal(calls.length, 1)
  assertWeatherCall(calls[0], "Tokyo")
})

test("local non-stream also invokes a custom tool", options, async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await requestChat(localURL, {
      stream: false,
      messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
      tools: [weatherTool()],
      tool_choice: "auto",
    })
    const choice = parseJSON(response.text, `non-stream tool invocation attempt ${attempt}`).choices[0]
    const calls = choice.message.tool_calls
    if (!calls?.length) continue
    assert.equal(choice.finish_reason, "tool_calls")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].type, "function")
    assertWeatherCall({ id: calls[0].id, ...calls[0].function }, "Tokyo")
    return
  }
  assert.fail("三次均未拿到工具调用，不能将未验证成功伪装成通过或 skip")
})

test("local streaming preserves three parallel tool calls", options, async () => {
  const cities = ["Tokyo", "Osaka", "Kyoto"]
  const { chunks, calls } = await invokeToolWithRetry(localURL, cities)
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map((call) => call.id)).size, 3, "并行调用必须有独立 id")
  assert.deepEqual(calls.map((call) => JSON.parse(call.arguments).city).sort(), [...cities].sort())
  calls.forEach((call) => assert.equal(call.name, "get_weather"))
  assert.equal(
    chunks.flatMap((chunk) => chunk.choices).find((choice) => choice.finish_reason)?.finish_reason,
    "tool_calls",
  )
})

test("Vercel entry streaming preserves three parallel tool calls by stable index", options, async () => {
  const cities = ["Tokyo", "Osaka", "Kyoto"]
  const { chunks, calls } = await invokeToolWithRetry(vercelURL, cities)
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map((call) => call.id)).size, 3)
  assert.deepEqual(calls.map((call) => JSON.parse(call.arguments).city).sort(), [...cities].sort())
  calls.forEach((call) => assert.equal(call.name, "get_weather"))
  assert.equal(
    chunks.flatMap((chunk) => chunk.choices).find((choice) => choice.finish_reason)?.finish_reason,
    "tool_calls",
  )
})

// auto 不保证每次调用工具，可有限重试；没有实际调用就失败，不能 skip 冒充验收。
async function invokeToolWithRetry(baseURL, cities = ["Tokyo"]) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await requestChat(baseURL, {
      stream: true,
      messages: [
        {
          role: "user",
          content:
            cities.length === 1
              ? "What is the weather in Tokyo? Use the get_weather tool."
              : `Call get_weather once for each of these cities, all in the same response: ${cities.join(", ")}. Do not answer without calling all three tools.`,
        },
      ],
      tools: [weatherTool()],
      tool_choice: "auto",
      max_tokens: 1024,
    })
    const chunks = assertStreamingResponse(response.text, `tool invocation attempt ${attempt}`)
    const calls = collectToolCalls(chunks)
    if (calls.length) return { chunks, calls }
  }
  assert.fail("三次均未拿到工具调用，工具联调没有验收成功")
}

// 模拟标准客户端，只按 choice/index 聚合；不能用 id 或“当前调用”兜底，
// 否则真实上游缺 index 时，测试自己修复了协议，会把代理的缺陷掩盖掉。
function collectToolCalls(chunks) {
  const calls = []
  const byChoice = new Map()
  for (const choice of chunks.flatMap((chunk) => chunk.choices)) {
    for (const part of choice.delta?.tool_calls ?? []) {
      assert.ok(Number.isInteger(choice.index) && choice.index >= 0, "工具调用必须带有效 choice index")
      assert.ok(Number.isInteger(part.index) && part.index >= 0, "每个工具片段必须带非负整数 index")
      if (!byChoice.has(choice.index)) byChoice.set(choice.index, { byIndex: new Map(), idIndexes: new Map() })
      const { byIndex, idIndexes } = byChoice.get(choice.index)
      if (!byIndex.has(part.index)) {
        const call = { id: "", name: "", arguments: "" }
        byIndex.set(part.index, call)
        calls.push(call)
      }
      const call = byIndex.get(part.index)
      if (part.id) {
        if (call.id) assert.equal(part.id, call.id, "同一 index 不能混入另一个工具调用")
        if (idIndexes.has(part.id)) assert.equal(part.index, idIndexes.get(part.id), "同一调用的 index 必须稳定")
        call.id = part.id
        idIndexes.set(part.id, part.index)
      }
      if (part.function?.name) call.name = part.function.name
      if (part.function?.arguments) call.arguments += part.function.arguments
    }
  }
  return calls
}

function assertWeatherCall(call, city) {
  assert.ok(call.id, "tool call 必须带 id，以便回填结果")
  assert.equal(call.name, "get_weather")
  assert.deepEqual(JSON.parse(call.arguments), { city })
}

function conversationMessages(assistantContent) {
  return [
    { role: "user", content: "hi" },
    { role: "assistant", content: assistantContent },
    { role: "user", content: "reply briefly with hi again" },
  ]
}

function assertStreamingResponse(text, scenario) {
  assert.equal(text.split("[DONE]").length - 1, 1, `${scenario} 应且只应有一个 [DONE]`)
  const chunks = parseSSEData(text, scenario)
  assert.ok(chunks.length > 0, `${scenario} has no JSON chunks`)
  for (const chunk of chunks) {
    assert.ok(!chunk.error, `${scenario} 包含流中错误：${JSON.stringify(chunk.error)}`)
    assert.ok(Array.isArray(chunk.choices), `${scenario} choices 必须是数组`)
  }
  return chunks
}

async function requestChat(baseURL, payload) {
  const headers = { "content-type": "application/json" }
  if (process.env.API_KEY) headers.authorization = `Bearer ${process.env.API_KEY}`
  const response = await fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "big-pickle", max_tokens: 256, temperature: 0, ...payload }),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await response.text()
  // 代理会把协议错也归一为 429，所以单凭 429 不能判定真实限流，更不能全局 skip。
  assert.equal(response.status, 200, `真实联调失败 HTTP ${response.status}: ${text}`)
  if (payload.stream) assert.match(response.headers.get("content-type"), /text\/event-stream/)
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
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
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
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
