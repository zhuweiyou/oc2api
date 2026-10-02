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

test("finish_reason 即完成信号：上游不关连接也有界收尾", { timeout: 8000 }, async () => {
  // 回归：完成信号若只用于"判定是否报错"而不用于收尾，上游发完 finish_reason
  // 却不关连接时，非流式会白等整个空闲窗口，然后把一份完整回答丢成 429。
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
    const started = Date.now()
    await handler(response, upstreamResponse, ctx)
    assert.ok(Date.now() - started < 5000, `${handler.name} 应在完成信号后立即收尾`)
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
