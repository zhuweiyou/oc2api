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
    assert.ok(!this.headersSent, "不能在响应头已发送后再次设置 header")
    this.headers[key.toLowerCase()] = value
  }
  flushHeaders() {
    this.headersSent = true
  }
  json(body) {
    this.body = body
    this.headersSent = true
    this.writableEnded = true
  }
  write(text) {
    this.headersSent = true
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

// 模拟标准客户端：只按 choice/index 聚合，不替代理用 id 或“当前调用”兜底。
function assertStreamToolCallsMatch(full, stream) {
  const choices = new Map()
  for (const chunk of payloads(stream.text)) {
    for (const choice of chunk.choices) {
      for (const part of choice.delta?.tool_calls ?? []) {
        assert.ok(Number.isInteger(part.index) && part.index >= 0, "每个工具增量必须带非负整数 index")
        if (!choices.has(choice.index)) choices.set(choice.index, new Map())
        const calls = choices.get(choice.index)
        if (!calls.has(part.index)) {
          calls.set(part.index, { id: "", type: "function", function: { name: "", arguments: "" } })
        }
        const call = calls.get(part.index)
        if (part.id) {
          if (call.id) assert.equal(part.id, call.id, "同一 index 不能换成另一个调用的 id")
          call.id = part.id
        }
        if (part.function?.name) call.function.name = part.function.name
        if (part.function?.arguments) call.function.arguments += part.function.arguments
      }
    }
  }
  const byId = (a, b) => a.id.localeCompare(b.id)
  for (const choice of full.body.choices) {
    const actual = [...(choices.get(choice.index)?.values() ?? [])].sort(byId)
    const expected = [...(choice.message.tool_calls ?? [])].sort(byId)
    assert.deepEqual(actual, expected, "仅按 index 聚合的流式工具结果应与非流式一致")
  }
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
    'data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"hi","name":"Space Bunny","cost":"0"}}],"usage":null,"cost":"0"}\n\n',
    finish,
    done,
  ].join("")
  const [full, stream] = await runBoth([raw])
  assert.equal(full.body.choices[0].message.content, "hi")
  assert.equal(full.body.choices[0].message.name, undefined)
  assert.equal(full.body.cost, undefined)
  for (const chunk of payloads(stream.text)) {
    assert.equal(chunk.cost, undefined)
    assert.notEqual(chunk.usage, null)
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

  // 归一化不得误删 tool_calls（曾在改字段清理时把整个字段删掉）。
  for (const chunk of [...payloads(stream.text), full.body]) {
    assert.ok(JSON.stringify(chunk).includes("tool_calls"), "tool_calls 必须保留下来")
  }
  assert.equal(streamCalls[0].type, "function")
  assert.equal(streamCalls[0].id, "call_1")
})

test("带工具调用却标成 stop 时归一为 tool_calls（对齐 opencode 官方）", async () => {
  // 实测 big-pickle 约 40% 的情况下把带工具调用的响应标成 finish_reason:"stop"，
  // 不归一的话下游会当作"回答结束"而不去执行工具。
  const call = (argumentsText) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: argumentsText } }] } }] })}\n\n`

  const [full, stream] = await runBoth([call("{}"), finish, done])
  assert.equal(full.body.choices[0].finish_reason, "tool_calls")
  const streamFinish = payloads(stream.text)
    .flatMap((chunk) => chunk.choices)
    .map((choice) => choice.finish_reason)
    .filter(Boolean)
  assert.deepEqual(streamFinish, ["tool_calls"])

  // 纯文本不受影响；length 等其它原因也不改写
  const [textFull] = await runBoth([partial, finish, done])
  assert.equal(textFull.body.choices[0].finish_reason, "stop")
  const [truncated] = await runBoth([
    call("{}"),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
    done,
  ])
  assert.equal(truncated.body.choices[0].finish_reason, "length")
})

test("多 choice 时 finish_reason 按 choice 独立归一", async () => {
  // 回归：归一若用全局"本响应是否带工具"判断，choice0 的工具调用会把
  // choice1（纯文本）的 stop 也错误改写成 tool_calls。
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "cA", type: "function", function: { name: "f", arguments: "{}" } }] },
        },
        { index: 1, delta: { content: "纯文本回答" } },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
        { index: 1, delta: {}, finish_reason: "stop" },
      ],
    })}\n\n`,
    done,
  ]
  const [full, stream] = await runBoth(chunks)
  assert.deepEqual(
    full.body.choices.map((c) => c.finish_reason),
    ["tool_calls", "stop"],
  )
  const streamFinish = payloads(stream.text)
    .flatMap((chunk) => chunk.choices)
    .filter((choice) => choice.finish_reason)
    .map((choice) => ({ index: choice.index, finish: choice.finish_reason }))
  assert.deepEqual(streamFinish, [
    { index: 0, finish: "tool_calls" },
    { index: 1, finish: "stop" },
  ])
})

test("多 choice 分别在不同帧 finish 时，后收尾的 choice 不能被吞掉", async () => {
  // 回归：完成判定若用全局布尔（sawDone/sawFinish），某个 choice 先 finish 后
  // 整帧都会被当成"越界"，后面 choice 的 finish_reason 直接丢失——流式整帧消失、
  // 非流式被下面的 ?? "stop" 掩盖成 stop。
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: { content: "a" } },
        { index: 1, delta: { content: "b" } },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 1, delta: {}, finish_reason: "length" }] })}\n\n`,
  ]
  const [full, stream] = await runBoth(chunks)
  assert.deepEqual(
    full.body.choices.map((c) => ({ index: c.index, finish: c.finish_reason, content: c.message.content })),
    [
      { index: 0, finish: "stop", content: "a" },
      { index: 1, finish: "length", content: "b" },
    ],
  )
  const streamFinish = payloads(stream.text)
    .flatMap((chunk) => chunk.choices)
    .filter((choice) => choice.finish_reason)
    .map((choice) => ({ index: choice.index, finish: choice.finish_reason }))
  assert.deepEqual(streamFinish, [
    { index: 0, finish: "stop" },
    { index: 1, finish: "length" },
  ])
})

test("越界帧按 choice 过滤：不污染已收尾的 choice，也不丢 usage", async () => {
  // 与上一条相对：已收尾 choice 的后续内容必须丢弃，但同帧的 usage 仍要保留，
  // 且新 index 不能凭空造出幽灵 choice。
  const tail = (choices) => `data: ${JSON.stringify({ choices, usage: { total_tokens: 9 } })}\n\n`
  for (const choices of [[{ index: 0, delta: { content: "LEAK" } }], [{ index: 5, delta: { content: "ghost" } }]]) {
    const [full, stream] = await runBoth([partial, finish, done, tail(choices)])
    assert.equal(full.body.choices.length, 1, JSON.stringify(choices))
    assert.equal(full.body.choices[0].message.content, "hi")
    assert.deepEqual(full.body.usage, { total_tokens: 9 })
    assert.ok(!stream.text.includes("LEAK") && !stream.text.includes("ghost"))
    assert.ok(!stream.text.includes('"index":5'))
  }
})

test("无 index 的工具调用：新调用要分开、参数续传要合并", async () => {
  // 上游的两种无 index 形态必须区分开（三方对照 main 验证过）：
  //   - 各自带新 id：是两个不同调用，不能合并；
  //   - 只有 arguments：是上一个调用的参数续传，必须并入同一调用，
  //     否则会拆成两个 JSON 非法的调用（main 与修复前都有这个缺陷）。
  const call = (id, argumentsText) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id, type: "function", function: { name: "get_weather", arguments: argumentsText } }] } }] })}\n\n`
  const continuation = (argumentsText) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: argumentsText } }] } }] })}\n\n`

  // 两个不同调用（各自带 id）不能被合并
  const [full] = await runBoth([call("call_A", '{"city":"Tokyo"}'), call("call_B", '{"city":"Osaka"}'), finish, done])
  const calls = full.body.choices[0].message.tool_calls
  assert.equal(calls.length, 2, "两个并行调用必须各自保留")
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Tokyo" })
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { city: "Osaka" })
  assert.notEqual(calls[0].id, calls[1].id)

  // 参数续传（无 id 无 name）要并入同一个调用，且参数拼成合法 JSON
  const [continued] = await runBoth([call("call_X", '{"ci'), continuation('ty":"SF"}'), finish, done])
  const single = continued.body.choices[0].message.tool_calls
  assert.equal(single.length, 1, "续传帧不能另起一个调用")
  assert.deepEqual(JSON.parse(single[0].function.arguments), { city: "SF" })
  assert.equal(single[0].function.name, "get_weather")

  // 两个并行调用各自续传：仍应是 2 个，且参数都完整
  const [parallel] = await runBoth([
    call("call_A", '{"city":"Tok'),
    continuation('yo"}'),
    call("call_B", '{"city":"Osa'),
    continuation('ka"}'),
    finish,
    done,
  ])
  const merged = parallel.body.choices[0].message.tool_calls
  assert.equal(merged.length, 2)
  assert.deepEqual(JSON.parse(merged[0].function.arguments), { city: "Tokyo" })
  assert.deepEqual(JSON.parse(merged[1].function.arguments), { city: "Osaka" })
})

test("带 index 与不带 index 的调用混用时不能串味", async () => {
  // 回归：自动槽位若用 calls.size 当键，index 0/1 占位后新调用会写到键 2，
  // 之后再来的 index:2 就会与它撞键、两个调用被揉在一起。
  const indexed = (index, id, name, argumentsText) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: argumentsText } }] } }] })}\n\n`
  const auto = (id, name, argumentsText) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id, type: "function", function: { name, arguments: argumentsText } }] } }] })}\n\n`

  const [full] = await runBoth([
    indexed(0, "c0", "f", "{}"),
    indexed(1, "c1", "f", "{}"),
    auto("cNew", "g", '{"x":1}'),
    indexed(2, "c2", "h", '{"y":2}'),
    finish,
    done,
  ])
  const calls = full.body.choices[0].message.tool_calls
  assert.equal(calls.length, 4, "四个调用必须各自独立")
  assert.deepEqual(
    calls.map((c) => c.id),
    ["c0", "c1", "cNew", "c2"],
    "输出顺序应保持上游到达顺序",
  )
  assert.deepEqual(
    calls.map((c) => c.function.name),
    ["f", "f", "g", "h"],
  )
  assert.deepEqual(JSON.parse(calls[2].function.arguments), { x: 1 })
  assert.deepEqual(JSON.parse(calls[3].function.arguments), { y: 2 })
})

test("多个并行工具调用按 index 独立累积，互不串味", async () => {
  const raw = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"get_time","arguments":"{\\"zone\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}},{"index":1,"function":{"arguments":"\\"JST\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    done,
  ].join("")
  const [full, stream] = await runBoth([raw])

  const calls = full.body.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].id, "call_a")
  assert.equal(calls[0].function.name, "get_weather")
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "SF" })
  assert.equal(calls[1].id, "call_b")
  assert.equal(calls[1].function.name, "get_time")
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { zone: "JST" })

  // 流式侧两个调用都必须出现，且各自的 arguments 只拼进自己那一支。
  const streamed = payloads(stream.text).flatMap((c) => c.choices.flatMap((x) => x.delta.tool_calls ?? []))
  const byIndex = new Map()
  for (const part of streamed) {
    const index = part.index ?? 0
    if (!byIndex.has(index)) byIndex.set(index, { name: "", arguments: "" })
    const target = byIndex.get(index)
    if (part.function?.name) target.name = part.function.name
    if (part.function?.arguments) target.arguments += part.function.arguments
  }
  assert.deepEqual(byIndex.get(0), { name: "get_weather", arguments: '{"city":"SF"}' })
  assert.deepEqual(byIndex.get(1), { name: "get_time", arguments: '{"zone":"JST"}' })
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

test("上游只回 usage、连 choice 都没有时判失败，两种模式一致", async () => {
  // 这是上游异常（正常至少会有一个 choice 帧），与"上游明确完成的空回答"不同。
  const onlyUsage = [`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`, done]
  const [full, stream] = await runBoth(onlyUsage)
  assert.equal(full.statusCode, 429)
  assert.match(full.body.error.message, /Empty/)
  assert.equal(stream.statusCode, 429)
  assert.match(stream.body.error.message, /Empty/)
})

test("上游明确完成的空回答按成功处理（对齐 opencode 官方语义）", async () => {
  // role + finish_reason:"stop" + [DONE]：模型合法地没有输出内容（拒答、max_tokens 极小）。
  // opencode 网关对 choices:[] 就是原样透传，不视为错误。
  const empty = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n' + done
  const [full, stream] = await runBoth([empty])
  assert.equal(full.statusCode, 200)
  assert.equal(full.body.choices[0].message.content, null)
  assert.equal(full.body.choices[0].finish_reason, "stop")
  assert.equal(stream.statusCode, 200)
  assert.equal(stream.text.split("[DONE]").length - 1, 1)
  assert.ok(!stream.text.includes("rate_limit_error"))
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

test("两种响应模式对完成的判定一致", async () => {
  // 回归：两模式曾各自判定，同一份输入可能一个判完成、一个判截断。
  // 注意流式在首个字节之后无法再改 HTTP 状态码，所以只比较"是否判为失败"。
  const streamFailed = (response) => /rate_limit_error/.test(response.text) || !response.text.includes("[DONE]")
  const cases = {
    正常完成: [[partial, finish, done], false],
    "仅 finish": [[partial, finish], false],
    "仅 DONE": [[partial, done], false],
    截断: [[partial], true],
    "仅 usage 无 choice": [[`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 1 } })}\n\n`, done], true],
    明确完成的空回答: [
      [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] })}\n\n`,
        done,
      ],
      false,
    ],
  }
  for (const [name, [chunks, shouldFail]] of Object.entries(cases)) {
    const [full, stream] = await runBoth(chunks)
    const jsonFailed = full.statusCode === 429
    assert.equal(jsonFailed, shouldFail, `非流式判定不符：${name}`)
    assert.equal(streamFailed(stream), shouldFail, `流式判定不符：${name}`)
  }
})

test("finish_reason 即完成信号：上游不关连接也在空闲窗口内成功收尾", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  // finish 已完整，但仍允许迟到 usage；空闲窗口耗尽也应成功，而不是把完整回答丢成 429。
  const encoder = new TextEncoder()
  const raw = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\n`,
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ].join("")
  for (const [handler, expected] of [
    [respondJson, (response) => assert.equal(response.body.choices[0].message.content, "hi")],
    [respondStream, (response) => assert.ok(response.text.includes("hi"))],
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
    const work = handler(response, upstreamResponse, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(120_000)
    await work
    assert.equal(response.statusCode, 200)
    expected(response)
  }
})

test("[DONE] 之后夹带 usage 的越界 choice 不会污染结果，也不产生幽灵 choice", async () => {
  const head = [partial, finish, done].join("")
  for (const [trailer, describe] of [
    [`data: {"choices":[{"index":0,"delta":{"content":"LEAK"}}],"usage":${JSON.stringify(usage)}}\n\n`, "同帧夹带正文"],
    [`data: {"choices":[{"index":5,"delta":{"content":"ghost"}}],"usage":${JSON.stringify(usage)}}\n\n`, "越界 index"],
  ]) {
    const [full, stream] = await runBoth([head + trailer])
    assert.equal(full.body.choices.length, 1, describe)
    assert.equal(full.body.choices[0].message.content, "hi", describe)
    assert.ok(!stream.text.includes("LEAK") && !stream.text.includes("ghost"), describe)
    assert.deepEqual(full.body.usage, usage, describe)
  }
})

test("[DONE] 之后的迟到错误或残缺帧不会毁掉已完成的回答", async () => {
  for (const trailer of [
    'data: {"choices":[],"usage":{"total_to',
    `data: ${JSON.stringify({ error: { message: "late" } })}\n\n`,
  ]) {
    const [full] = await runBoth([[partial, finish, done].join("") + trailer])
    assert.equal(full.statusCode, 200)
    assert.equal(full.body.choices[0].message.content, "hi")
  }
})

test("只有 role 的帧之后上游报错时仍能退回 JSON 429", async () => {
  // 早期版本会先 flushHeaders，导致账号池在流式路径上看不到 429。
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    `data: ${JSON.stringify({ error: { message: "upstream blew up" } })}\n\n`,
    done,
  ]
  for (const response of await runBoth(chunks)) {
    assert.equal(response.statusCode, 429)
    assert.match(response.body.error.message, /blew up/)
  }
})

test("上游异常刷屏无内容帧时有界放行，不会无界攒内存", async () => {
  // 回归：早前版本把首个正文之前的所有无内容帧都压进数组，上游持续刷这种帧时
  // 内存无界增长（实测 20 万帧约 70MB），而且一帧都发不出去。
  const encoder = new TextEncoder()
  const total = 5000
  let sent = 0
  const response = new ResponseStub()
  const upstreamResponse = new Response(
    new ReadableStream({
      pull(controller) {
        if (sent > total) return // 永不 close：模拟上游空转
        const frame =
          sent === 0
            ? { choices: [{ index: 0, delta: { role: "assistant" } }] }
            : { choices: [{ index: 0, delta: {} }] }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        sent++
      },
    }),
  )
  const work = respondStream(response, upstreamResponse, ctx)
  await new Promise((resolve) => setTimeout(resolve, 200))
  // 关键断言：超过上限后必须开始放行，不能一直攒着
  assert.ok(response.text.length > 0, "超过上限后应开始转发，而不是无限缓冲")
  assert.ok(sent > 0)
  response.destroyed = true
  response.emit("close")
  await work.catch(() => {})
})

test("非流式聚合保留 legacy function_call 等未知 delta 字段", async () => {
  // 流式是纯透传，非流式若是白名单重组，同一份输入在两种模式下结果就不同。
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", function_call: { name: "get_weather", arguments: '{"ci' } } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { function_call: { arguments: 'ty":"SF"}' }, refusal: "no" } }] })}\n\n`,
    finish,
    done,
  ]
  const [full, stream] = await runBoth(chunks)
  const message = full.body.choices[0].message
  // name 与 arguments 分属不同帧：合并时不能把先到的 name 覆盖掉。
  assert.equal(message.function_call.name, "get_weather")
  assert.equal(message.function_call.arguments, '{"city":"SF"}')
  assert.equal(message.refusal, "no")
  assert.match(stream.text, /function_call/)
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

test("上游首帧静默与正文停滞分别按真实超时窗口失败", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  for (const [head, window] of [
    ["", 30_000],
    [partial, 120_000],
  ]) {
    const reader = new Response(
      new ReadableStream({
        start(controller) {
          if (head) controller.enqueue(new TextEncoder().encode(head))
        },
      }),
    ).body.getReader()
    const work = (async () => {
      for await (const _ of readEvents(reader, ctx)) void _
    })()
    const failure = assert.rejects(work, /idle timeout/)
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(window)
    await failure
    await reader.cancel()
  }
})

test("空 reasoning 不能遮住有效 reasoning_content", async () => {
  const raw = 'data: {"choices":[{"index":0,"delta":{"reasoning":"","reasoning_content":"kept","content":"hi"}}]}\n\n'
  const [full, stream] = await runBoth([raw, finish, done])
  assert.equal(full.body.choices[0].message.reasoning_content, "kept")
  assert.equal(
    payloads(stream.text)
      .flatMap((c) => c.choices)
      .map((c) => c.delta?.reasoning_content ?? "")
      .join(""),
    "kept",
  )
})

test("超过无内容帧缓冲上限后仍保持顺序，不让旧 usage 覆盖新 usage", async () => {
  const chunks = Array.from(
    { length: 12 },
    (_, sequence) =>
      `data: ${JSON.stringify({ sequence, choices: [{ index: 0, delta: sequence === 0 ? { role: "assistant" } : {} }], usage: { total_tokens: sequence } })}\n\n`,
  )
  const [full, stream] = await runBoth([...chunks, finish, done])
  assert.deepEqual(
    payloads(stream.text)
      .filter((c) => c.sequence != null)
      .map((c) => c.sequence),
    Array.from({ length: 12 }, (_, i) => i),
  )
  assert.equal(full.body.usage.total_tokens, 11)
  assert.equal(
    payloads(stream.text)
      .filter((c) => c.usage)
      .at(-1).usage.total_tokens,
    11,
  )
})

test("非数组 choices 与无效 tool_call 项不再抛 TypeError，保留有效增量", async () => {
  const calls = [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }]
  const [full, stream] = await runBoth([
    'data: {"choices":{}}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":{}}}]}\n\n',
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi", tool_calls: [null, ...calls] } }] })}\n\n`,
    finish,
    done,
  ])
  assert.equal(full.statusCode, 200)
  assert.equal(full.body.choices[0].message.content, "hi")
  assert.equal(full.body.choices[0].message.tool_calls.length, 1)
  assert.equal(full.body.choices[0].message.tool_calls[0].id, "c")
  assert.equal(stream.statusCode, 200)
  assert.ok(stream.text.includes("[DONE]"))
})

test("多 choice 中仅一个 finish 不能掩盖其余 choice 截断", async () => {
  const head = `data: ${JSON.stringify({
    choices: [
      { index: 0, delta: { content: "a" } },
      { index: 1, delta: { content: "b" } },
    ],
  })}\n\n`
  const [full, stream] = await runBoth([head, finish])
  assert.equal(full.statusCode, 429)
  assert.match(full.body.error.message, /Incomplete/)
  assert.ok(!stream.text.includes("[DONE]"))
  assert.match(stream.text, /Incomplete/)
})

test("单 choice finish 后新 index 不能生成幽灵 choice，即使没有 DONE", async () => {
  const ghost = 'data: {"choices":[{"index":5,"delta":{"content":"ghost"}}],"usage":{"total_tokens":9}}\n\n'
  const [full, stream] = await runBoth([partial, finish, ghost])
  assert.equal(full.body.choices.length, 1)
  assert.equal(full.body.choices[0].message.content, "hi")
  assert.equal(full.body.usage.total_tokens, 9)
  assert.ok(!stream.text.includes("ghost") && !stream.text.includes('"index":5'))
})

test("多 choice 后收尾延迟超过一秒仍完整读取", { timeout: 8000 }, async () => {
  const head =
    `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: { content: "a" } },
        { index: 1, delta: { content: "b" } },
      ],
    })}\n\n` + finish
  for (const handler of [respondJson, respondStream]) {
    let timer
    const response = new ResponseStub()
    const source = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head))
          timer = setTimeout(() => {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":1,"delta":{"content":"c"},"finish_reason":"length"}]}\n\n' + done,
              ),
            )
            controller.close()
          }, 1100)
        },
        cancel() {
          clearTimeout(timer)
        },
      }),
    )
    await handler(response, source, ctx)
    if (handler === respondJson) {
      assert.equal(response.body.choices[1].message.content, "bc")
      assert.equal(response.body.choices[1].finish_reason, "length")
    } else {
      const second = payloads(response.text)
        .flatMap((c) => c.choices)
        .filter((c) => c.index === 1)
      assert.equal(second.map((c) => c.delta?.content ?? "").join(""), "bc")
      assert.equal(second.at(-1).finish_reason, "length")
    }
  }
})

test("背压暂停消费不计入上游空闲超时，也不丢已排队尾部 usage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  for (const [blockedFrame, stall] of [
    [partial, 121_000],
    [finish, 1100],
  ]) {
    const response = new ResponseStub()
    const originalWrite = response.write.bind(response)
    let blocked = false
    response.write = (text) => {
      originalWrite(text)
      if (!blocked && text.includes(blockedFrame === partial ? '"content"' : '"finish_reason"')) {
        blocked = true
        return false
      }
      return true
    }
    const work = respondStream(
      response,
      upstream([partial, finish, `data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`, done]),
      ctx,
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(response.listenerCount("drain"), 1, "尚未 drain 时应停止消费上游")
    t.mock.timers.tick(stall)
    response.emit("drain")
    await work
    assert.ok(!response.text.includes("rate_limit_error"))
    assert.deepEqual(payloads(response.text).find((c) => c.usage)?.usage, usage)
    assert.ok(response.text.includes("[DONE]"))
    assert.equal(response.listenerCount("drain"), 0)
  }
})

test("正文保持原样：不误删普通 thinking 词句或字面 think 标签", async () => {
  for (const content of ["I am thinking about the response", "<think>literal</think> text"]) {
    const [full, stream] = await runBoth([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
      finish,
      done,
    ])
    assert.equal(full.body.choices[0].message.content, content)
    assert.equal(
      payloads(stream.text)
        .flatMap((c) => c.choices)
        .map((c) => c.delta?.content ?? "")
        .join(""),
      content,
    )
  }
})

test("HTTP 200 原始 JSON 错误立即识别，不必等待 SSE 空闲窗口或 EOF", async () => {
  for (const handler of [respondJson, respondStream]) {
    let cancelled = false
    const response = new ResponseStub()
    const source = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":{"message":"raw limit","type":"FreeUsageLimitError"}}'))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    await handler(response, source, ctx)
    assert.equal(response.statusCode, 429)
    assert.match(response.body.error.message, /raw limit/)
    assert.ok(cancelled)
  }
})

test("原始 JSON 错误跨网络块切开 UTF-8 字符时，诊断文本不损坏", async () => {
  const bytes = new TextEncoder().encode('{"error":{"message":"你好，限制"}}')
  for (let split = 1; split < bytes.length; split++) {
    for (const response of await runBoth([bytes.subarray(0, split), bytes.subarray(split)])) {
      assert.equal(response.statusCode, 429)
      assert.equal(response.body.error.message, "你好，限制 (free model rate limit)", `split=${split}`)
    }
  }
})

test("碎片化原始 JSON 错误有界解析，不逐字节重复 JSON.parse", async (t) => {
  const raw = JSON.stringify({ error: { message: "fragmented limit" }, padding: "x".repeat(20_000) })
  const parse = JSON.parse
  let parses = 0
  t.mock.method(JSON, "parse", (...args) => {
    parses++
    return parse(...args)
  })
  for (const handler of [respondJson, respondStream]) {
    parses = 0
    const response = new ResponseStub()
    await handler(response, upstream([...new TextEncoder().encode(raw)].map((byte) => Uint8Array.of(byte))), ctx)
    assert.equal(response.statusCode, 429)
    assert.match(response.body.error.message, /fragmented limit/)
    assert.ok(parses <= 2, `原始 JSON 错误只应解析首段与最终正文，实际 ${parses} 次`)
  }
})

test("残缺原始 JSON 错误最多读取一秒，超大错误正文受字节上限保护", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  for (const handler of [respondJson, respondStream]) {
    let cancelled = false
    const response = new ResponseStub()
    const source = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    const work = handler(response, source, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1000)
    await work
    assert.equal(response.statusCode, 429)
    assert.ok(cancelled)
    const big = new ResponseStub()
    await handler(big, upstream(['{"error":{"message":"' + "x".repeat(70_000) + '"}}']), ctx)
    assert.equal(big.statusCode, 429)
    assert.ok(big.body.error.message.length < 100, "错误正文过大时应返回有界诊断，不回显无限长 message")
  }
})

test("无 index 首帧后出现 index 的续传必须绑定原调用，不能拆成两份", async () => {
  const frame = (tool_calls) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}\n\n`
  for (const includeIds of [false, true]) {
    const head = frame([
      { id: "A", type: "function", function: { name: "weather", arguments: '{"city":' } },
      { id: "B", type: "function", function: { name: "weather", arguments: '{"city":' } },
    ])
    const tail = frame([
      { index: 1, ...(includeIds ? { id: "B" } : {}), function: { arguments: '"Osaka"}' } },
      { index: 0, ...(includeIds ? { id: "A" } : {}), function: { arguments: '"Tokyo"}' } },
    ])
    const [full] = await runBoth([head, tail, finish, done])
    const calls = full.body.choices[0].message.tool_calls
    assert.equal(calls.length, 2)
    assert.deepEqual(
      calls.map((call) => call.id),
      ["A", "B"],
    )
    assert.deepEqual(
      calls.map((call) => JSON.parse(call.function.arguments).city),
      ["Tokyo", "Osaka"],
    )
  }
  const [lateName] = await runBoth([
    frame([{ id: "A", type: "function", function: { name: "wea", arguments: '{"city":' } }]),
    frame([{ index: 0, function: { name: "weather", arguments: '"Tokyo"}' } }]),
    finish,
    done,
  ])
  const calls = lateName.body.choices[0].message.tool_calls
  assert.equal(calls.length, 1, "无 id 的 indexed 续传可补全 name，不应该因为 name 不同又拆调用")
  assert.equal(calls[0].function.name, "weather")
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Tokyo" })
})

test("真实 index 与自动槽位同号但 id 不同时，不能把新调用并入旧调用", async () => {
  const frame = (tool_calls) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}\n\n`
  const [full] = await runBoth([
    frame([{ id: "A", type: "function", function: { name: "a", arguments: "{}" } }]),
    frame([{ index: 0, id: "B", type: "function", function: { name: "b", arguments: "{}" } }]),
    finish,
    done,
  ])
  assert.deepEqual(
    full.body.choices[0].message.tool_calls.map((call) => call.id),
    ["A", "B"],
  )
})

test("无 index 的重复 id 续传应按 id 归并，不能被当作新调用", async () => {
  for (const indexedFirst of [false, true]) {
    const calls = [
      {
        ...(indexedFirst ? { index: 0 } : {}),
        id: "A",
        type: "function",
        function: { name: "weather", arguments: '{"city":' },
      },
      { id: "B", type: "function", function: { name: "weather", arguments: '{"city":"Osaka"}' } },
    ]
    const head = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls } }] })}\n\n`
    const tail = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: "A", function: { arguments: '"Tokyo"}' } }] } }] })}\n\n`
    const [full] = await runBoth([head, tail, finish, done])
    const result = full.body.choices[0].message.tool_calls
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((call) => call.id),
      ["A", "B"],
    )
    assert.deepEqual(
      result.map((call) => JSON.parse(call.function.arguments).city),
      ["Tokyo", "Osaka"],
    )
  }
})

test("标准 indexed 工具调用按 index 还原顺序，而非首帧到达顺序", async () => {
  const frame = `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: "B", type: "function", function: { name: "b", arguments: "{}" } },
            { index: 0, id: "A", type: "function", function: { name: "a", arguments: "{}" } },
          ],
        },
      },
    ],
  })}\n\n`
  const [full] = await runBoth([frame, finish, done])
  assert.deepEqual(
    full.body.choices[0].message.tool_calls.map((c) => c.id),
    ["A", "B"],
  )
})

test("finish 到 DONE 之前的迟到 usage 不受一秒窗口截断", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  for (const handler of [respondJson, respondStream]) {
    let controller
    const source = new Response(
      new ReadableStream({
        start(c) {
          controller = c
          c.enqueue(new TextEncoder().encode(partial + finish))
        },
      }),
    )
    const response = new ResponseStub()
    const work = handler(response, source, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1500)
    controller.enqueue(new TextEncoder().encode(`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n` + done))
    controller.close()
    await work
    if (handler === respondJson) assert.deepEqual(response.body.usage, usage)
    else assert.deepEqual(payloads(response.text).find((c) => c.usage)?.usage, usage)
  }
})

test("流式工具 index：缺失、续传和混合调用按稳定 index 聚合", async (t) => {
  const frame = (...tool_calls) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}\n\n`
  const head = (id, argumentsText, index) => ({
    ...(index === undefined ? {} : { index }),
    id,
    type: "function",
    function: { name: "weather", arguments: argumentsText },
  })
  const tail = (argumentsText, index, id) => ({
    ...(index === undefined ? {} : { index }),
    ...(id === undefined ? {} : { id }),
    function: { arguments: argumentsText },
  })
  const scenarios = [
    {
      name: "同帧并行首片缺 index，重复 id 可交错续传",
      chunks: [
        frame(head("A", '{"city":'), head("B", '{"city":')),
        frame(tail('"Osaka"}', undefined, "B"), tail('"Tokyo"}', undefined, "A")),
      ],
      indexes: [0, 1, 1, 0],
    },
    {
      name: "只有 arguments 的无 index 续传沿用当前调用",
      chunks: [frame(head("A", '{"city":')), frame(tail('"Tokyo"}'))],
      indexes: [0, 0],
    },
    {
      name: "无 index 首片后，只有 index 的续传绑定原调用",
      chunks: [frame(head("A", '{"city":'), head("B", '{"city":')), frame(tail('"Osaka"}', 1), tail('"Tokyo"}', 0))],
      indexes: [0, 1, 1, 0],
    },
    {
      name: "后到的上游 index 只建立别名，不改变已发送的 index",
      chunks: [frame(head("A", '{"city":'), head("B", "{}")), frame(tail('"To', 7, "A")), frame(tail('kyo"}', 7))],
      indexes: [0, 1, 0, 0],
    },
    {
      name: "真实 index 与已发送的自动 index 碰撞时独立分配",
      chunks: [frame(head("A", "{}")), frame(head("B", "{}", 0)), frame(tail("", undefined, "A"), tail("", 0))],
      indexes: [0, 1, 0, 1],
    },
    {
      name: "indexed 和自动槽位混用，碰撞后的续传仍不串参数",
      chunks: [
        frame(head("c0", "{}", 0), head("c1", "{}", 1)),
        frame(head("A", '{"city":')),
        frame(head("B", '{"city":', 2)),
        frame(tail('"Tokyo"}', undefined, "A"), tail('"Osaka"}', 2)),
      ],
      indexes: [0, 1, 2, 3, 2, 3],
    },
    {
      name: "标准 indexed 流乱序到达也保留原 index",
      chunks: [
        frame(head("B", '{"city":', 3), head("A", '{"city":', 0)),
        frame(tail('"Osaka"}', 3), tail('"Tokyo"}', 0)),
      ],
      indexes: [3, 0, 3, 0],
    },
    {
      name: "名字晚到的 indexed 续传仍属于同一调用",
      chunks: [
        frame({ id: "A", type: "function", function: { arguments: '{"city":' } }),
        frame({ index: 0, function: { name: "weather", arguments: '"Tokyo"}' } }),
      ],
      indexes: [0, 0],
    },
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const [full, stream] = await runBoth([...scenario.chunks, finish, done])
      assertStreamToolCallsMatch(full, stream)
      const calls = payloads(stream.text).flatMap((chunk) =>
        chunk.choices.flatMap((choice) => choice.delta?.tool_calls ?? []),
      )
      assert.deepEqual(
        calls.map((call) => call.index),
        scenario.indexes,
      )
      const original = scenario.chunks.flatMap((chunk) =>
        payloads(chunk).flatMap((event) => event.choices.flatMap((choice) => choice.delta.tool_calls)),
      )
      const withoutIndex = (call) => {
        const copy = { ...call }
        delete copy.index
        return copy
      }
      assert.deepEqual(
        calls.map(withoutIndex),
        original.map(withoutIndex),
        "只归一 index，不改写 id、函数名、参数片段或增量边界",
      )
    })
  }
})

test("流式工具 index：不同 choice 和不同请求的映射互相隔离", async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 1,
          delta: { tool_calls: [{ id: "A", type: "function", function: { name: "weather", arguments: "{}" } }] },
        },
        {
          index: 0,
          delta: { tool_calls: [{ id: "A", type: "function", function: { name: "weather", arguments: '{"city":' } }] },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"Tokyo"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [0, 1].map((index) => ({ index, delta: {}, finish_reason: "stop" })) })}\n\n`,
    done,
  ]
  for (let request = 0; request < 2; request++) {
    const [full, stream] = await runBoth(chunks, { ctx: { choiceCount: 2 } })
    assertStreamToolCallsMatch(full, stream)
    const calls = payloads(stream.text).flatMap((chunk) =>
      chunk.choices.flatMap((choice) => choice.delta?.tool_calls ?? []),
    )
    assert.deepEqual(
      calls.map((call) => call.index),
      [0, 0, 0],
    )
  }
})

test("流式工具 index：首个参数片段立即发送，不等待调用结束", async () => {
  const encoder = new TextEncoder()
  let controller
  const source = new Response(
    new ReadableStream({
      start(c) {
        controller = c
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"A","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
          ),
        )
      },
    }),
  )
  const response = new ResponseStub()
  let firstSent = false
  const write = response.write.bind(response)
  response.write = (text) => {
    const result = write(text)
    if (!firstSent) {
      firstSent = true
      const call = payloads(text)[0].choices[0].delta.tool_calls[0]
      assert.equal(call.index, 0)
      assert.equal(call.function.arguments, '{"city":')
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\"Tokyo\\"}"}}]}}]}\n\n' +
            finish +
            done,
        ),
      )
      controller.close()
    }
    return result
  }
  await respondStream(response, source, ctx)
  assert.ok(firstSent)
  const calls = payloads(response.text).flatMap((chunk) =>
    chunk.choices.flatMap((choice) => choice.delta?.tool_calls ?? []),
  )
  assert.deepEqual(
    calls.map((call) => call.index),
    [0, 0],
  )
  assert.equal(calls.map((call) => call.function.arguments).join(""), '{"city":"Tokyo"}')
})

test("n 提供期望 choice 数时，后出现的 choice 不会被首个 finish 当成越界", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1 })
  for (const handler of [respondJson, respondStream]) {
    let controller
    const source = new Response(
      new ReadableStream({
        start(c) {
          controller = c
          c.enqueue(new TextEncoder().encode(partial + finish))
        },
      }),
    )
    const response = new ResponseStub()
    const work = handler(response, source, { ...ctx, choiceCount: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1500)
    controller.enqueue(
      new TextEncoder().encode(
        'data: {"choices":[{"index":1,"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n' + done,
      ),
    )
    controller.close()
    await work
    if (handler === respondJson) assert.equal(response.body.choices[1].message.content, "second")
    else assert.ok(response.text.includes("second"))
  }
})
