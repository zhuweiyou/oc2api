import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import localApp from "../../server/index.js"
import app from "../../server/app.js"
import { createOpenAIStreamNormalizer } from "../../server/openai.js"
import { buildZenRequest } from "../../server/zen.js"

const CUSTOM_TOOL = {
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

test("local and Vercel entries export the same Express app", () => {
  assert.strictEqual(localApp, app)
  assert.strictEqual(vercelApp, app)
})

test("health and OPTIONS responses work through the Express app", async (t) => {
  const server = await listen(app)
  t.after(() => close(server))

  const health = await request(server.url, { path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.text).status, "ok")
  assert.equal(health.headers["access-control-allow-origin"], "*")
  assert.equal(health.headers["x-powered-by"], undefined)

  const options = await request(server.url, {
    method: "OPTIONS",
    path: "/v1/chat/completions",
  })
  assert.equal(options.status, 204)
  assert.equal(options.headers["access-control-allow-methods"], "GET, POST, OPTIONS")
})

test("unknown paths return 404 without going through auth", async (t) => {
  const previousApiKey = process.env.API_KEY
  process.env.API_KEY = "sk-test"
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
  })

  // 不带 key：未注册路径不经过鉴权，直接 404
  const noAuth = await request(server.url, { path: "/nope" })
  assert.equal(noAuth.status, 404)
  assert.deepEqual(JSON.parse(noAuth.text), { error: { message: "Not found" } })

  // 带错误 key：同样 404，而不是 401
  const wrongKey = await request(server.url, {
    method: "POST",
    path: "/nope",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: "{}",
  })
  assert.equal(wrongKey.status, 404)

  // 已注册的受保护路径缺 key 仍是 401
  const protectedNoAuth = await request(server.url, { path: "/v1/models" })
  assert.equal(protectedNoAuth.status, 401)
})

test("public routes stay open when API_KEY is set, trailing slashes tolerated", async (t) => {
  const previousApiKey = process.env.API_KEY
  const previousFetch = globalThis.fetch
  process.env.API_KEY = "sk-test"
  // /ip 会访问外部服务商，离线测试里 mock 掉
  globalThis.fetch = async () => new Response("your ip is 203.0.113.7", { status: 200 })
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
    globalThis.fetch = previousFetch
  })

  for (const path of ["/", "/health", "/ip", "/health//"]) {
    const response = await request(server.url, { path })
    assert.equal(response.status, 200, `expected 200 for ${path}`)
  }
  assert.equal(JSON.parse((await request(server.url, { path: "/health" })).text).status, "ok")
  assert.equal(JSON.parse((await request(server.url, { path: "/ip" })).text).ip, "203.0.113.7")
})

test("invalid JSON returns an OpenAI error instead of Express HTML", async (t) => {
  const previousApiKey = process.env.API_KEY
  delete process.env.API_KEY
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
  })

  const response = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: "{",
  })

  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.text), {
    error: { message: "Invalid JSON body", type: "invalid_request_error" },
  })
})

test("API key authentication rejects missing and wrong keys with 401", async (t) => {
  const previousApiKey = process.env.API_KEY
  const previousFetch = globalThis.fetch
  process.env.API_KEY = "sk-test"
  globalThis.fetch = async () =>
    new Response(mockSSEBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
    globalThis.fetch = previousFetch
  })

  const payload = {
    method: "POST",
    path: "/v1/chat/completions",
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      stream: false,
    }),
  }

  const noAuth = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json" },
  })
  assert.equal(noAuth.status, 401)
  assert.deepEqual(JSON.parse(noAuth.text), {
    error: { message: "Invalid API key", type: "authentication_error" },
  })

  const wrongKey = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
  })
  assert.equal(wrongKey.status, 401)

  const validKey = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
  })
  assert.equal(validKey.status, 200)
})

test("normalizers apply the same content rules to every model", () => {
  // 开启思考（默认）：content 剥离 think 块，reasoning/reasoning_content 归一为 reasoning_content
  const normalizer = createOpenAIStreamNormalizer("custom-model")
  const normalized = normalizer.normalize({
    choices: [
      {
        index: 0,
        delta: {
          content: "<thinking>hidden</thinking>hi",
          reasoning: "trace",
          reasoning_content: "legacy",
        },
      },
    ],
  })

  assert.equal(normalized.model, "custom-model")
  assert.equal(normalized.choices[0].delta.content, "hi")
  assert.equal(normalized.choices[0].delta.reasoning_content, "tracelegacyhidden")
  assert.equal(normalized.choices[0].delta.reasoning, undefined)

  // 关闭思考：reasoning 系列字段全部删除，think 块剥离后丢弃
  const disabled = createOpenAIStreamNormalizer("custom-model", false)
  const stripped = disabled.normalize({
    choices: [
      {
        index: 0,
        delta: {
          content: "<thinking>hidden</thinking>hi",
          reasoning: "trace",
          reasoning_content: "legacy",
        },
      },
    ],
  })
  assert.deepEqual(stripped.choices[0].delta, { content: "hi" })

  // reasoning_effort 原样透传（"none" 关闭思考，其余开启）
  const request = buildZenRequest(
    "custom-model",
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }],
    true,
    null,
    null,
    "low",
    "ses_test",
    32,
    0.7,
  )
  const body = JSON.parse(request.body)
  assert.equal(body.reasoning_effort, "low")
  assert.equal(body.temperature, 0.7)
  assert.equal(body.messages[0].content[0].type, "image_url")
})

test("non-stream and stream requests share the same upstream business path", async (t) => {
  const previousFetch = globalThis.fetch
  const previousApiKey = process.env.API_KEY
  const calls = []
  delete process.env.API_KEY
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(mockSSEBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }

  const server = await listen(app)
  t.after(() => {
    close(server)
    globalThis.fetch = previousFetch
    restoreEnv("API_KEY", previousApiKey)
  })

  const basePayload = {
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32,
  }
  const nonStream = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...basePayload,
      stream: false,
      tools: [CUSTOM_TOOL],
      tool_choice: "none",
    }),
  })
  assert.equal(nonStream.status, 200)
  assert.match(nonStream.headers["x-request-id"] || "", /^req_/)
  assert.match(nonStream.headers["access-control-expose-headers"] || "", /x-request-id/i)
  const completion = JSON.parse(nonStream.text)
  assert.equal(completion.model, "big-pickle")
  assert.equal(completion.choices[0].message.content, "hi")
  // 默认开启思考：reasoning_content 聚合上游 reasoning/reasoning_content
  assert.equal(completion.choices[0].message.reasoning, undefined)
  assert.equal(completion.choices[0].message.reasoning_content, "tracelegacyhidden")

  const upstreamBody = JSON.parse(calls[0].init.body)
  assert.equal(upstreamBody.model, "big-pickle")
  assert.equal(upstreamBody.stream, true)
  assert.equal(upstreamBody.tool_choice, "none")
  assert.ok(upstreamBody.tools.some((tool) => tool.function?.name === "get_weather"))

  const stream = await request(server.url, {
    method: "POST",
    path: "/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...basePayload, stream: true }),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers["content-type"], /text\/event-stream/)
  assert.match(stream.text, /data:/)
  assert.match(stream.text, /\[DONE\]/)
  assert.equal(calls.length, 2)
})

function mockSSEBody() {
  return [
    `data: ${JSON.stringify({ id: "chatcmpl-test", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "<thinking>hidden</thinking>hi", reasoning: "trace", reasoning_content: "legacy" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
}

async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

async function close({ server }) {
  if (!server.listening) return
  server.close()
  await once(server, "close")
}

function request(baseURL, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseURL)
    const requestHeaders = { ...headers }
    if (body !== undefined) requestHeaders["content-length"] = Buffer.byteLength(body)
    const outgoing = httpRequest(url, { method, headers: requestHeaders }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
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

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
