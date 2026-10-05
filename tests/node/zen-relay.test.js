import assert from "node:assert/strict"
import test from "node:test"

test("custom upstream routes models and unchanged chat requests through a relay", async (t) => {
  const previousBase = process.env.ZEN_API_BASE_URL
  const previousTimeout = process.env.ZEN_CONNECT_TIMEOUT_MS
  process.env.ZEN_API_BASE_URL = "http://127.0.0.1:2082/v1///"
  process.env.ZEN_CONNECT_TIMEOUT_MS = "300000"
  t.after(() => {
    if (previousBase === undefined) delete process.env.ZEN_API_BASE_URL
    else process.env.ZEN_API_BASE_URL = previousBase
    if (previousTimeout === undefined) delete process.env.ZEN_CONNECT_TIMEOUT_MS
    else process.env.ZEN_CONNECT_TIMEOUT_MS = previousTimeout
  })
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options])
    return new Response(JSON.stringify({ data: [{ id: "ling-3.1-flash-free" }] }))
  })
  const zen = await import("../../server/zen.js?relay-test")
  await zen.listModels()
  const request = zen.buildUpstreamRequest({ model: "ling-3.1-flash-free", messages: [] }, "ses_test")
  await zen.fetchUpstream(request, { requestId: "test", model: "ling-3.1-flash-free" })
  assert.equal(calls[0][0], "http://127.0.0.1:2082/v1/models")
  assert.equal(calls[1][0], "http://127.0.0.1:2082/v1/chat/completions")
  assert.equal(calls[1][1].body, request.body)
  assert.equal(calls[1][1].headers, request.headers)
})

test("invalid connect timeout fails at startup", async (t) => {
  const previous = process.env.ZEN_CONNECT_TIMEOUT_MS
  process.env.ZEN_CONNECT_TIMEOUT_MS = "NaN"
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_CONNECT_TIMEOUT_MS
    else process.env.ZEN_CONNECT_TIMEOUT_MS = previous
  })
  await assert.rejects(import("../../server/zen.js?invalid-timeout-test"), /ZEN_CONNECT_TIMEOUT_MS/)
})
