// Workers 适配层（worker/src/respond.js）的离线测试。
// 入口与 Node 版共用 server/openai.js 的帧编排，这里只验证传输层：SSE 帧输出、
// 非流式聚合、上游错误映射，以及「尚未提交响应头时能退回 JSON 错误」。
import assert from "node:assert/strict"
import test from "node:test"

import { respondJson, respondStream } from "../../worker/src/respond.js"

const encoder = new TextEncoder()

function upstream(chunks, status = 200) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
        }
        controller.close()
      },
    }),
    { status },
  )
}

function sse(rows) {
  return rows.map((row) => `data: ${typeof row === "string" ? row : JSON.stringify(row)}\n\n`).join("")
}

function chunk(delta, extra = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "big-pickle",
    choices: [{ index: 0, delta, ...extra }],
  }
}

function ctx(overrides = {}) {
  return {
    requestId: "req_test",
    model: "big-pickle",
    thinkingEnabled: true,
    status: 200,
    toolsDisabled: false,
    toolAliases: new Map(),
    reservedToolNames: ["read"],
    clientToolNames: [],
    ...overrides,
  }
}

test("Workers 流式：帧按 SSE 写出，思考归一为 reasoning_content，收尾补 [DONE]", async () => {
  const body = sse([
    chunk({ role: "assistant" }),
    chunk({ reasoning: "想一想" }),
    chunk({ content: "你好" }),
    chunk({}, { finish_reason: "stop" }),
    "[DONE]",
  ])
  const response = await respondStream(upstream([body]), ctx())
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8")
  assert.equal(response.headers.get("x-request-id"), "req_test")
  assert.ok(text.includes('"reasoning_content":"想一想"'), "上游 reasoning 应归一为 reasoning_content")
  assert.ok(text.includes('"content":"你好"'))
  assert.ok(text.trimEnd().endsWith("data: [DONE]"), "流必须以 [DONE] 收尾")
  assert.ok(!text.includes('"reasoning":"想一想"'), "原始 reasoning 字段不应透传")
})

test("Workers 流式：finish_reason 带工具时归一为 tool_calls", async () => {
  const body = sse([
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } }] }),
    chunk({}, { finish_reason: "stop" }),
    "[DONE]",
  ])
  const text = await (await respondStream(upstream([body]), ctx({ clientToolNames: ["get_weather"] }))).text()
  assert.ok(text.includes('"finish_reason":"tool_calls"'), "带工具调用时 stop 应改写为 tool_calls")
})

test("Workers 流式：上游误选保留工具时以错误结束，不交给客户端执行", async () => {
  const body = sse([
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] }),
    chunk({}, { finish_reason: "stop" }),
    "[DONE]",
  ])
  const text = await (await respondStream(upstream([body]), ctx())).text()
  assert.ok(text.includes("upstream_stream_error"), "保留工具调用必须被拦下")
  assert.ok(!text.trimEnd().endsWith("[DONE]"), "错误结束不能补 [DONE]")
})

test("Workers 流式：首帧之前就失败时退回 JSON 错误，而不是半截 SSE", async () => {
  const body = sse([{ error: { message: "boom", type: "server_error" } }])
  const response = await respondStream(upstream([body]), ctx())
  assert.equal(response.status, 502)
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
  const payload = await response.json()
  assert.equal(payload.error.type, "upstream_error")
})

test("Workers 非流式：把流聚合为 chat.completion", async () => {
  const body = sse([
    chunk({ role: "assistant" }),
    chunk({ content: "你" }),
    chunk({ content: "好" }),
    chunk({ reasoning: "想" }),
    chunk({}, { finish_reason: "stop" }),
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    "[DONE]",
  ])
  const response = await respondJson(upstream([body]), ctx())
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, "chat.completion")
  assert.equal(payload.choices[0].message.content, "你好")
  assert.equal(payload.choices[0].message.reasoning_content, "想")
  assert.equal(payload.choices[0].finish_reason, "stop")
  assert.deepEqual(payload.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
})

test("Workers 非流式：工具调用分片聚合成一条完整 tool_calls", async () => {
  const body = sse([
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }] }),
    chunk({}, { finish_reason: "tool_calls" }),
    "[DONE]",
  ])
  const payload = await (await respondJson(upstream([body]), ctx())).json()

  assert.deepEqual(payload.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
  ])
  assert.equal(payload.choices[0].finish_reason, "tool_calls")
})

test("Workers 上游非 2xx：状态码与错误语义原样映射", async () => {
  const limited = await respondStream(
    upstream([JSON.stringify({ error: { message: "slow down" } })], 429),
    ctx({ status: 429 }),
  )
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).error.type, "rate_limit_error")

  const denied = await respondJson(upstream(["{}"], 403), ctx({ status: 403 }))
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.type, "authentication_error")
})
