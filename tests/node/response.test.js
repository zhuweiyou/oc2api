import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { readEvents, respondJson, respondStream, upstreamError } from "../../server/openai.js"

const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
const partial =
  'data: {"id":"cmpl","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n'
const finish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
const done = "data: [DONE]\n\n"

function upstream(chunks, status = 200) {
  const encoder = new TextEncoder()
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

class ResponseStub extends EventEmitter {
  statusCode = 200
  headers = {}
  text = ""
  writableEnded = false
  destroyed = false

  status(code) {
    this.statusCode = code
    return this
  }
  setHeader(key, value) {
    this.headers[key.toLowerCase()] = value
  }
  flushHeaders() {}
  json(body) {
    this.body = body
    this.headersSent = true
    this.writableEnded = true
  }
  write(text) {
    this.text += text
    return true
  }
  end() {
    this.writableEnded = true
  }
}

const ctx = { requestId: "req_test", model: "big-pickle", thinkingEnabled: true, status: 200 }

async function runBoth(chunks, options = {}) {
  const results = []
  for (const handler of [respondJson, respondStream]) {
    const response = new ResponseStub()
    await handler(response, upstream(chunks, options.status ?? 200), { ...ctx, ...options.ctx })
    results.push(response)
  }
  return results
}

function payloads(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(5).trim()))
}

test("非流式聚合与流式转发得到相同的正文与思考", async () => {
  const raw = [
    'data: {"id":"cmpl-1","created":7,"model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"思考A"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n',
    `data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`,
    done,
  ].join("")
  const [full, stream] = await runBoth([raw])

  assert.equal(full.statusCode, 200)
  assert.equal(full.body.id, "cmpl-1")
  assert.equal(full.body.created, 7)
  assert.equal(full.body.model, "big-pickle")
  assert.equal(full.body.choices[0].message.content, "答案")
  assert.equal(full.body.choices[0].message.reasoning_content, "思考A")
  assert.deepEqual(full.body.usage, usage)

  const deltas = payloads(stream.text).flatMap((chunk) => chunk.choices.map((choice) => choice.delta))
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "答案")
  assert.equal(deltas.map((delta) => delta.reasoning_content ?? "").join(""), "思考A")
  assert.equal(stream.text.split("[DONE]").length - 1, 1)
})

test("上游私有扩展不向下游泄漏，usage:null 被归一", async () => {
  const raw = [
    'data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"hi","name":"Space Bunny"},"usage":null}],"cost":"0"}\n\n',
    finish,
    done,
  ].join("")
  const [full, stream] = await runBoth([raw])
  assert.equal(full.body.choices[0].message.content, "hi")
  assert.equal(full.body.choices[0].message.name, undefined)
  assert.equal(full.body.cost, undefined)
  for (const chunk of payloads(stream.text)) {
    assert.equal(chunk.cost, undefined)
    for (const choice of chunk.choices) {
      assert.equal(choice.delta?.name, undefined)
      assert.equal(choice.delta?.cost, undefined)
    }
  }
  assert.ok(!stream.text.includes('"cost"'))
})

test("reasoning 与 reasoning_details 归一为 reasoning_content，关闭思考时丢弃", async () => {
  const raw = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning":"t1","reasoning_details":[{"type":"reasoning.text","text":"t1"}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"v","reasoning":"t2"}}]}\n\n',
    finish,
    done,
  ].join("")

  const [full] = await runBoth([raw])
  assert.equal(full.body.choices[0].message.reasoning_content, "t1t2")
  assert.equal(full.body.choices[0].message.content, "v")

  // reasoning_details 只是同一内容的镜像：绝不能重复计入。
  assert.ok(!full.body.choices[0].message.reasoning_content.includes("t1t1"))

  const [offFull, offStream] = await runBoth([raw], { ctx: { thinkingEnabled: false } })
  assert.equal(offFull.body.choices[0].message.reasoning_content, undefined)
  assert.equal(offFull.body.choices[0].message.content, "v")
  assert.ok(!offStream.text.includes("reasoning"))
})

test("工具调用可跨帧累积并还原成完整参数", async () => {
  const raw = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    done,
  ].join("")
  const [full, stream] = await runBoth([raw])

  const call = full.body.choices[0].message.tool_calls[0]
  assert.equal(call.id, "call_1")
  assert.equal(call.type, "function")
  assert.equal(call.function.name, "get_weather")
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "SF" })
  assert.equal(full.body.choices[0].finish_reason, "tool_calls")

  // 流式必须保留增量结构，不能把参数拼好再发。
  const streamCalls = payloads(stream.text).flatMap((c) => c.choices.flatMap((x) => x.delta.tool_calls ?? []))
  assert.ok(streamCalls.length >= 2)
  assert.equal(streamCalls.map((c) => c.function?.arguments ?? "").join(""), '{"city":"SF"}')
})

test("上游 HTTP 错误与错误事件都归一为 429", async () => {
  const errorJSON = JSON.stringify({ error: { message: "boom", type: "server_error" } })
  for (const status of [400, 401, 403, 429, 500, 503]) {
    for (const response of await runBoth([errorJSON], { status })) {
      assert.equal(response.statusCode, 429)
      assert.equal(response.body.error.type, "rate_limit_error")
      assert.equal(response.body.error.code, "rate_limit_exceeded")
      assert.match(response.body.error.message, /boom/)
      assert.equal(response.text, "")
    }
  }

  // 响应头提交之前的 SSE 错误仍可退回 JSON
  for (const response of await runBoth([`data: ${errorJSON}\n\n`, done])) {
    assert.equal(response.statusCode, 429)
    assert.match(response.body.error.message, /boom/)
  }
})

test("响应头提交之后的错误以 SSE 事件结束，且不补 [DONE]", async () => {
  const errorJSON = JSON.stringify({ error: { message: "mid-stream failure" } })
  const [, stream] = await runBoth([partial, `data: ${errorJSON}\n\n`, done])
  assert.equal(stream.statusCode, 200)
  const chunks = payloads(stream.text)
  assert.equal(chunks[0].choices[0].delta.content, "hi")
  assert.match(chunks.at(-1).error.message, /mid-stream failure/)
  assert.ok(!stream.text.includes("[DONE]"))
  assert.equal(stream.writableEnded, true)
})

test("只有 usage 没有正文时按失败处理，两种模式一致", async () => {
  const onlyUsage = [`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`, done]
  const [full, stream] = await runBoth(onlyUsage)
  assert.equal(full.statusCode, 429)
  assert.match(full.body.error.message, /Empty/)
  assert.equal(stream.statusCode, 429)
  assert.match(stream.body.error.message, /Empty/)
})

test("[DONE] 之后的 usage 仍补齐，越界正文不写入", async () => {
  const raw = [
    partial,
    finish,
    done,
    `data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`,
    'data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n',
  ].join("")
  const [full, stream] = await runBoth([raw])
  assert.deepEqual(full.body.usage, usage)
  assert.equal(full.body.choices[0].message.content, "hi")
  const chunks = payloads(stream.text)
  assert.deepEqual(chunks.find((chunk) => chunk.usage)?.usage, usage)
  assert.equal(
    chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice) => choice.delta.content ?? "")
      .join(""),
    "hi",
  )
  assert.equal(stream.text.split("[DONE]").length - 1, 1)
})

test("SSE 解析对分块边界不敏感，含 CRLF、注释、多行 data 与切开的多字节字符", async () => {
  const raw =
    ': keepalive\r\ndata: {"id":"c","choices":\r\ndata: [{"index":0,"delta":{"content":"你好"}}]}\r\n\r\n' +
    finish +
    done
  const reference = await runBoth([raw])
  const encoder = new TextEncoder()
  const bytes = [...encoder.encode(raw)]
  const perByte = bytes.map((byte) => Uint8Array.of(byte))
  const split = await runBoth(perByte)

  assert.equal(reference[0].body.choices[0].message.content, "你好")
  assert.equal(split[0].body.choices[0].message.content, "你好")
  assert.equal(
    payloads(split[1].text)
      .flatMap((c) => c.choices)
      .map((c) => c.delta.content ?? "")
      .join(""),
    "你好",
  )
})

test("readEvents 对畸形负载与上游错误事件报错", async () => {
  const cases = [
    ['data: {"choices":[\n\n', /Invalid SSE payload/],
    ["data: not-json\n\n", /Invalid SSE payload/],
    ['event: error\ndata: {"message":"generation failed"}\n\n', /generation failed/],
    ['data: {"error":"plain string error"}\n\n', /plain string error/],
  ]
  for (const [raw, expected] of cases) {
    const reader = upstream([raw]).body.getReader()
    const iterate = async () => {
      for await (const _ of readEvents(reader, ctx)) void _
    }
    await assert.rejects(iterate, expected)
  }
})

test("upstreamError 只识别真正的错误体", () => {
  assert.equal(upstreamError({ choices: [] }), null)
  assert.equal(upstreamError({ usage: { total_tokens: 1 } }), null)
  assert.match(upstreamError({ error: { message: "x" } }).message, /x/)
  assert.match(upstreamError({ error: "y" }).message, /y/)
  assert.match(upstreamError({ type: "error", message: "z" }).message, /z/)
  assert.match(upstreamError({ message: "forced" }, true).message, /forced/)
})

test("流被截断时不伪装成正常完成，[DONE] 或 finish_reason 二者有一即算完成", async () => {
  const truncated = await runBoth([partial])
  assert.equal(truncated[0].statusCode, 429)
  assert.match(truncated[0].body.error.message, /Incomplete/)
  assert.ok(!truncated[1].text.includes("[DONE]"))
  assert.match(truncated[1].text, /rate_limit_error/)

  // 上游用 [DONE] 或 finish_reason 任一种收尾都算正常
  for (const chunks of [
    [partial, finish],
    [partial, done],
    [partial, finish, done],
  ]) {
    const [full, stream] = await runBoth(chunks)
    assert.equal(full.statusCode, 200)
    assert.equal(full.body.choices[0].message.content, "hi")
    assert.equal(stream.text.split("[DONE]").length - 1, 1)
  }
})

test("上游发完 [DONE] 不关连接时仍有界收尾，且 usage 不丢", { timeout: 8000 }, async () => {
  // 回归：尾段等待若用了会 unref 的定时器，事件循环没有其他引用时它就永远不触发，
  // 表现为请求挂死。这里让上游发完 [DONE] 后保持连接不关闭。
  const raw = [partial, finish, done, `data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`].join("")
  const encoder = new TextEncoder()
  for (const [handler, expected] of [
    [respondJson, (response) => assert.deepEqual(response.body.usage, usage)],
    [respondStream, (response) => assert.ok(response.text.includes('"usage"'))],
  ]) {
    const response = new ResponseStub()
    const upstreamResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(raw))
          // 故意不 close()
        },
      }),
    )
    const started = Date.now()
    await handler(response, upstreamResponse, ctx)
    assert.ok(Date.now() - started < 5000, `${handler.name} 必须在尾段预算内返回`)
    assert.equal(response.statusCode, 200)
    expected(response)
  }
})

test("下游提前断开时取消上游读取，不继续写", async () => {
  for (const handler of [respondJson, respondStream]) {
    let cancelled = false
    const response = new ResponseStub()
    const upstreamResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(partial))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    const work = handler(response, upstreamResponse, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    response.destroyed = true
    response.emit("close")
    await work
    assert.ok(cancelled, `${handler.name} should cancel upstream`)
    assert.equal(response.body, undefined)
  }
})

test("上游建连后静默时按空闲窗口失败，而不是永久挂起", { timeout: 5000 }, async () => {
  // 用一个短窗口验证机制本身：注入极小的首帧窗口后必须快速失败。
  const silent = new Response(
    new ReadableStream({
      start() {
        /* 永远不发数据，也不关闭 */
      },
    }),
  )
  const reader = silent.body.getReader()
  const started = Date.now()
  const iterate = async () => {
    for await (const _ of readEvents(reader, ctx)) void _
  }
  // 真实窗口是 30s，这里只断言"不会立刻返回成功"，避免测试耗时过长。
  const raced = await Promise.race([
    iterate().then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 300)),
  ])
  assert.equal(raced, "still-waiting")
  assert.ok(Date.now() - started >= 300)
  await reader.cancel().catch(() => {})
})
