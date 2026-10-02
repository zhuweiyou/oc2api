import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import app from "../../server/app.js"
import { config } from "../../server/config.js"

const sse = [
  'data: {"id":"cmpl-1","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"total_tokens":2}}\n\n',
  "data: [DONE]\n\n",
].join("")

const base = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] }

test("Vercel 入口导出同一个 Express app", () => {
  assert.strictEqual(vercelApp, app)
})

test("health、CORS 与未知路径不经过鉴权", async (t) => {
  const previousApiKey = config.apiKey
  config.apiKey = "sk-test"
  const server = await listen(app)
  t.after(async () => {
    config.apiKey = previousApiKey
    await close(server)
  })

  const health = await request(server.url, { path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.text).status, "ok")
  assert.equal(health.headers["access-control-allow-origin"], "*")
  assert.equal(health.headers["x-powered-by"], undefined)

  const options = await request(server.url, { method: "OPTIONS", path: "/v1/chat/completions" })
  assert.equal(options.status, 204)
  assert.equal(options.headers["access-control-allow-methods"], "GET, POST, OPTIONS")

  // 未注册路径直接 404，不因缺 key 变 401
  const missing = await request(server.url, { path: "/nope" })
  assert.equal(missing.status, 404)
  assert.equal(JSON.parse(missing.text).error.message, "Not found")

  // 受保护路径缺 key 才是 401
  const protectedPath = await request(server.url, { path: "/v1/models" })
  assert.equal(protectedPath.status, 401)
  assert.equal(JSON.parse(protectedPath.text).error.type, "authentication_error")
})

test("无效 JSON 返回 OpenAI 风格 400，错误 key 返回 401", async (t) => {
  const previousApiKey = config.apiKey
  config.apiKey = "sk-test"
  const server = await listen(app)
  t.after(async () => {
    config.apiKey = previousApiKey
    await close(server)
  })

  const badJson = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: "{",
  })
  assert.equal(badJson.status, 400)
  assert.deepEqual(JSON.parse(badJson.text), {
    error: { message: "Invalid JSON body", type: "invalid_request_error" },
  })

  const wrongKey = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
    body: JSON.stringify(base),
  })
  assert.equal(wrongKey.status, 401)
})

test("门面校验拒绝付费模型与空 messages，且不请求上游", async (t) => {
  let fetchCalls = 0
  const server = await fixture(t, async () => {
    fetchCalls++
    throw new Error("must not reach upstream")
  })

  for (const [payload, expected] of [
    [{ ...base, model: "gpt-6-astra" }, /Only big-pickle/],
    [{ ...base, model: "" }, /non-empty string/],
    [{ ...base, model: 123 }, /non-empty string/],
    [{ ...base, messages: [] }, /non-empty array/],
    [{ ...base, messages: "hi" }, /non-empty array/],
    [{ model: "big-pickle" }, /non-empty array/],
    ["not-an-object", /Invalid JSON body/],
  ]) {
    const response = await post(server.url, payload)
    assert.equal(response.status, 400, JSON.stringify(payload))
    assert.match(JSON.parse(response.text).error.message, expected)
  }
  assert.equal(fetchCalls, 0, "校验必须发生在上游请求之前")
})

test("合法请求端到端：流式与非流式都能拿到正文与 usage", async (t) => {
  const forwarded = []
  const server = await fixture(t, async (_url, init) => {
    forwarded.push(JSON.parse(init.body))
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  })

  const nonStream = await post(server.url, { ...base, stream: false })
  assert.equal(nonStream.status, 200)
  const completion = JSON.parse(nonStream.text)
  assert.equal(completion.choices[0].message.content, "hi")
  assert.deepEqual(completion.usage, { total_tokens: 2 })
  assert.match(nonStream.headers["x-request-id"] ?? "", /^req_/)
  assert.equal(forwarded.at(-1).stream, true, "上游只接受流式")

  // 用户没传 tools：必须补齐免费层门禁工具并禁止选中它们
  const names = forwarded.at(-1).tools.map((tool) => tool.function.name)
  assert.ok(names.includes("bash") && names.includes("read"))
  assert.equal(forwarded.at(-1).tool_choice, "none")

  const stream = await post(server.url, { ...base, stream: true })
  assert.equal(stream.status, 200)
  assert.match(stream.headers["content-type"], /text\/event-stream/)
  assert.match(stream.text, /data: /)
  assert.equal(stream.text.split("[DONE]").length - 1, 1)

  // 用户 tools 原样保留并沿用 tool_choice / temperature
  const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object" } } }
  await post(server.url, { ...base, stream: false, tools: [weather], tool_choice: "auto", temperature: 0.5 })
  const last = forwarded.at(-1)
  assert.equal(last.tool_choice, "auto")
  assert.equal(last.temperature, 0.5)
  assert.ok(last.tools.some((tool) => tool.function.name === "get_weather"))
})

test("上游失败时返回 429，供账号池切换", async (t) => {
  const server = await fixture(
    t,
    async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  )
  const response = await post(server.url, base)
  assert.equal(response.status, 429)
  const body = JSON.parse(response.text)
  assert.equal(body.error.type, "rate_limit_error")
  assert.equal(body.error.code, "rate_limit_exceeded")
  assert.match(body.error.message, /rate limited/)
})

test("公开 IP、根路径及尾斜杠仍免鉴权，IP 供应商失败可回退", async (t) => {
  const previousFetch = globalThis.fetch
  const previousApiKey = config.apiKey
  config.apiKey = "sk-test"
  globalThis.fetch = async (url) =>
    String(url).includes("ipquery") ? new Response("bad", { status: 503 }) : new Response('{"query":"203.0.113.7"}')
  const server = await listen(app)
  t.after(async () => {
    globalThis.fetch = previousFetch
    config.apiKey = previousApiKey
    await close(server)
  })
  for (const path of ["/", "/health//?probe=1", "/ip"]) {
    const response = await request(server.url, { path })
    assert.equal(response.status, 200, path)
  }
  assert.equal(JSON.parse((await request(server.url, { path: "/ip" })).text).ip, "203.0.113.7")
})

test("正确 Bearer 与 X-API-Key 可以访问受保护的聊天路径及别名", async (t) => {
  const server = await fixture(t, async () => new Response(sse))
  config.apiKey = "sk-test"
  for (const [path, headers] of [
    ["/v1/chat/completions", { authorization: "Bearer sk-test" }],
    ["/chat/completions//", { "x-api-key": "sk-test" }],
  ]) {
    const response = await request(server.url, {
      method: "POST",
      path,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(base),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers["access-control-expose-headers"], /x-request-id/i)
  }
})

test("HTTP thinking 默认开启、none 关闭，camelCase 别名也影响真实上游请求", async (t) => {
  const forwarded = []
  const trace =
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hi","reasoning":"trace"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  const server = await fixture(t, async (_url, init) => {
    forwarded.push(JSON.parse(init.body))
    return new Response(trace)
  })
  for (const stream of [false, true]) {
    for (const effort of [undefined, "none", "high"]) {
      const input = { ...base, stream, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      const response = await post(server.url, input)
      assert.equal(response.status, 200)
      const body = stream ? response.text : JSON.parse(response.text).choices[0].message
      assert.equal(stream ? body.includes("reasoning_content") : Boolean(body.reasoning_content), effort !== "none")
      assert.equal(forwarded.at(-1).reasoning_effort, effort)
      assert.equal(forwarded.at(-1).reasoningEffort, undefined)
    }
  }
})

test("多模态输入及 max_completion_tokens 原样透传", async (t) => {
  let forwarded
  const server = await fixture(t, async (_url, init) => {
    forwarded = JSON.parse(init.body)
    return new Response(sse)
  })
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "auto" } },
      ],
    },
  ]
  const response = await post(server.url, { ...base, messages, max_completion_tokens: 9 })
  assert.equal(response.status, 200)
  assert.deepEqual(forwarded.messages, messages)
  assert.equal(forwarded.max_completion_tokens, 9)
  assert.equal(forwarded.max_tokens, undefined)
})

test("建连失败及超时维持 main 的 502/504，而不误标为限流", async (t) => {
  let failure = new Error("network failed")
  const server = await fixture(t, async () => {
    throw failure
  })
  assert.equal((await post(server.url, base)).status, 502)
  failure = new Error("timeout")
  assert.equal((await post(server.url, base)).status, 504)
})

test("模型列表失败不缓存、body 超时归 504，成功仅缓存免费模型", async (t) => {
  let calls = 0
  const server = await fixture(t, async () => {
    calls++
    if (calls === 1) return new Response("{}", { status: 500 })
    if (calls === 2) return new Response("not-json")
    if (calls === 3)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("timeout", "AbortError"))
          },
        }),
      )
    return new Response(
      JSON.stringify({ data: [{ id: "paid" }, { id: "big-pickle" }, { id: "mimo-v2.6-flash-free" }] }),
    )
  })
  for (const status of [502, 502, 504]) assert.equal((await request(server.url, { path: "/v1/models" })).status, status)
  for (const path of ["/v1/models", "/models"]) {
    const response = await request(server.url, { path })
    assert.equal(response.status, 200)
    assert.deepEqual(
      JSON.parse(response.text).data.map((model) => model.id),
      ["big-pickle", "mimo-v2.6-flash-free"],
    )
  }
  assert.equal(calls, 4, "成功结果被缓存，错误不应缓存")
})

test("HTTP 两种模式都能完成两个工具调用、结果回填及下一轮回答", async (t) => {
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }]
  const toolFrames =
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "A", type: "function", function: { name: "weather", arguments: '{"city":' } },
                { index: 1, id: "B", type: "function", function: { name: "weather", arguments: '{"city":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"Tokyo"}' } },
                { index: 1, function: { arguments: '"Osaka"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  let roundTrips = 0
  const server = await fixture(t, async (_url, init) => {
    const body = JSON.parse(init.body)
    if (!body.messages.some((m) => m.role === "tool")) return new Response(toolFrames)
    roundTrips++
    assert.deepEqual(
      body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["A", "B"],
    )
    assert.deepEqual(
      body.messages.find((m) => m.role === "assistant").tool_calls.map((c) => JSON.parse(c.function.arguments).city),
      ["Tokyo", "Osaka"],
    )
    return new Response(sse)
  })
  for (const stream of [false, true]) {
    const first = await post(server.url, { ...base, tools, stream })
    assert.equal(first.status, 200)
    let message
    if (!stream) message = JSON.parse(first.text).choices[0].message
    else {
      const calls = new Map()
      const choices = first.text
        .split("\n")
        .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
        .flatMap((line) => JSON.parse(line.slice(5)).choices)
      assert.equal(choices.at(-1).finish_reason, "tool_calls")
      for (const part of choices.flatMap((c) => c.delta.tool_calls ?? [])) {
        if (!calls.has(part.index))
          calls.set(part.index, {
            id: part.id,
            type: "function",
            function: { name: part.function.name, arguments: "" },
          })
        calls.get(part.index).function.arguments += part.function.arguments ?? ""
      }
      message = { role: "assistant", content: null, tool_calls: [...calls.values()] }
    }
    assert.equal(message.tool_calls.length, 2)
    const result = await post(server.url, {
      ...base,
      tools,
      stream,
      messages: [
        ...base.messages,
        message,
        ...message.tool_calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: '{"temp":18}' })),
      ],
    })
    assert.equal(result.status, 200)
    assert.match(result.text, /hi/)
  }
  assert.equal(roundTrips, 2)
})

async function fixture(t, fetchImpl) {
  const previousFetch = globalThis.fetch
  const previousApiKey = config.apiKey
  config.apiKey = undefined
  globalThis.fetch = fetchImpl
  const server = await listen(app)
  t.after(async () => {
    globalThis.fetch = previousFetch
    config.apiKey = previousApiKey
    await close(server)
  })
  return server
}

async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

async function close({ server }) {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

function post(url, payload) {
  return request(url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

function request(baseURL, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, baseURL), { method, headers }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("error", reject)
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      )
    })
    outgoing.on("error", reject)
    if (body !== undefined) outgoing.write(body)
    outgoing.end()
  })
}
