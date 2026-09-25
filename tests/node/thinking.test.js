import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { once } from "node:events"
import test from "node:test"

import app from "../../server/app.js"
import { config } from "../../server/config.js"
import { createOpenAIStreamNormalizer, stripThinkBlocks } from "../../server/openai.js"
import { buildZenRequest } from "../../server/zen.js"

// ==================== 流式归一化 ====================

test("thinking on: merges reasoning fields into reasoning_content output", () => {
  const normalizer = createOpenAIStreamNormalizer("big-pickle", true)
  const chunk = normalizer.normalize({
    choices: [
      {
        index: 0,
        delta: {
          content: "visible",
          reasoning: "trace-a",
          reasoning_content: "trace-b",
        },
      },
    ],
  })
  assert.equal(chunk.choices[0].delta.content, "visible")
  assert.equal(chunk.choices[0].delta.reasoning_content, "trace-atrace-b")
  assert.equal(chunk.choices[0].delta.reasoning, undefined)
})

test("thinking on: strips think blocks from content and keeps them as reasoning_content", () => {
  const normalizer = createOpenAIStreamNormalizer("big-pickle", true)
  const chunk = normalizer.normalize({
    choices: [
      {
        index: 0,
        delta: { content: "<thinking>hidden</thinking>hi" },
      },
    ],
  })
  assert.equal(chunk.choices[0].delta.content, "hi")
  assert.equal(chunk.choices[0].delta.reasoning_content, "hidden")
})

test("thinking on: reasoning-only deltas (mimo style) become reasoning_content", () => {
  const normalizer = createOpenAIStreamNormalizer("mimo-v2.5-free", true)
  const chunk = normalizer.normalize({
    choices: [{ index: 0, delta: { reasoning: "think text" } }],
  })
  assert.equal(chunk.choices[0].delta.reasoning_content, "think text")
  assert.equal(chunk.choices[0].delta.reasoning, undefined)
})

test("thinking off: drops all reasoning fields and strips think blocks", () => {
  const normalizer = createOpenAIStreamNormalizer("big-pickle", false)
  const chunk = normalizer.normalize({
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
  assert.deepEqual(chunk.choices[0].delta, { content: "hi" })
})

test("thinking off default: keeps behavior aligned with no reasoning_effort = on", () => {
  // thinkingEnabled 缺省视为开启（reasoning_effort 非 "none"）
  const normalizer = createOpenAIStreamNormalizer("big-pickle")
  const chunk = normalizer.normalize({
    choices: [{ index: 0, delta: { reasoning: "trace" } }],
  })
  assert.equal(chunk.choices[0].delta.reasoning_content, "trace")
})

test("stripThinkBlocks handles tag, marker, multi-block and unclosed forms", () => {
  assert.equal(stripThinkBlocks("<thinking>a</thinking>hi"), "hi")
  assert.equal(stripThinkBlocks(" pre<thinking>a</thinking>post<thinking>b</thinking>end "), "prepostend ")
  assert.equal(stripThinkBlocks("normal text"), "normal text")
  // 流式跨块:先开未闭,后续补上闭合标签
  const closed = stripThinkBlocks("<thinking>unclosed")
  assert.equal(closed, "")
})

// ==================== buildZenRequest ====================

test("buildZenRequest passes reasoning_effort through unchanged", () => {
  const high = JSON.parse(
    buildZenRequest("big-pickle", [{ role: "user", content: "hi" }], true, null, null, "high", "ses_x", 32, null).body,
  )
  assert.equal(high.reasoning_effort, "high")

  const none = JSON.parse(
    buildZenRequest("big-pickle", [{ role: "user", content: "hi" }], true, null, null, "none", "ses_x", 32, null).body,
  )
  assert.equal(none.reasoning_effort, "none")
})

test("buildZenRequest omits reasoning_effort when not provided", () => {
  const req = buildZenRequest(
    "big-pickle",
    [{ role: "user", content: "hi" }],
    true,
    null,
    null,
    null,
    "ses_x",
    32,
    null,
  )
  const body = JSON.parse(req.body)
  assert.equal(body.reasoning_effort, undefined)
})

// ==================== HTTP 层 ====================

function mockSSEBody({ thinking = true } = {}) {
  const delta = {
    role: "assistant",
    content: "<thinking>hidden</thinking>hi",
    reasoning: "trace",
    reasoning_content: "legacy",
  }
  if (!thinking) {
    delete delta.reasoning
    delete delta.reasoning_content
  }
  return [
    `data: ${JSON.stringify({ id: "chatcmpl-think", created: 1, choices: [{ index: 0, delta }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
}

test("HTTP non-stream: thinking on emits reasoning_content, thinking off does not", async (t) => {
  const previousFetch = globalThis.fetch
  const previousApiKey = config.apiKey
  const calls = []
  config.apiKey = undefined
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const thinking = (() => {
      try {
        return JSON.parse(init.body).reasoning_effort !== "none"
      } catch {
        return true
      }
    })()
    return new Response(mockSSEBody({ thinking }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  const server = await listen(app)
  t.after(() => {
    close(server)
    globalThis.fetch = previousFetch
    config.apiKey = previousApiKey
  })

  const post = (body) =>
    request(server.url, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  // reasoning_effort 未指定 → 开启思考
  const on = await post({
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32,
    stream: false,
  })
  assert.equal(on.status, 200)
  const onBody = JSON.parse(on.text)
  assert.equal(onBody.choices[0].message.content, "hi")
  assert.equal(onBody.choices[0].message.reasoning_content, "tracelegacyhidden")

  // reasoning_effort: "none" → 关闭思考：上游不产生思考，响应也无 reasoning_content
  const off = await post({
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32,
    stream: false,
    reasoning_effort: "none",
  })
  assert.equal(off.status, 200)
  const offBody = JSON.parse(off.text)
  assert.equal(offBody.choices[0].message.content, "hi")
  assert.equal(offBody.choices[0].message.reasoning_content, undefined)

  // 上游请求体：none 原样透传
  const upstreamOff = JSON.parse(calls[1].init.body)
  assert.equal(upstreamOff.reasoning_effort, "none")
})

test("HTTP stream: thinking on streams reasoning_content deltas", async (t) => {
  const previousFetch = globalThis.fetch
  config.apiKey = undefined
  globalThis.fetch = async () =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "<thinking>h</thinking>v", reasoning: "t1" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "t2" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  const server = await listen(app)
  t.after(() => {
    close(server)
    globalThis.fetch = previousFetch
  })

  const res = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  })
  assert.match(res.headers["content-type"], /text\/event-stream/)

  const deltas = parseSSEData(res.text)
  const reasoningDeltas = deltas
    .flatMap((d) => d.choices || [])
    .map((c) => c.delta)
    .filter((d) => d.reasoning_content !== undefined && d.reasoning_content !== null)
  assert.ok(reasoningDeltas.length >= 2, `expected reasoning deltas, got ${JSON.stringify(deltas.slice(0, 3))}`)
  const joined = reasoningDeltas.map((d) => d.reasoning_content).join("")
  assert.equal(joined, "t1ht2")
  // content 里 think 块被剥离
  const contentDeltas = deltas
    .flatMap((d) => d.choices || [])
    .map((c) => c.delta?.content)
    .filter(Boolean)
  assert.deepEqual(contentDeltas, ["v"])
})

// ==================== helper ====================

function parseSSEData(text) {
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
    .map((payload) => JSON.parse(payload))
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
