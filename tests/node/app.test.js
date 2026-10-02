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
