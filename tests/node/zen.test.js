import assert from "node:assert/strict"
import test from "node:test"

import { buildUpstreamRequest, gateTool, isAllowedModelId, getSession } from "../../server/zen.js"

test("免费层必要条件：UA、session、门禁工具、强制流式", () => {
  const request = buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }, "ses_test")
  const body = JSON.parse(request.body)

  assert.equal(body.stream, true, "stream:false 会被上游 403，必须强制 true")
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.match(request.headers["User-Agent"], /^opencode\//)
  assert.equal(request.headers.Authorization, "Bearer public")
  assert.equal(request.headers["x-opencode-session"], "ses_test")

  const names = body.tools.map((tool) => tool.function.name)
  assert.ok(names.includes("bash") && names.includes("read"), "缺少 bash/read 会 403")
  assert.equal(body.tool_choice, "none", "无用户工具时必须禁止选中门禁工具")
})

test("业务字段原样透传，只有门禁相关字段被补齐", () => {
  const payload = {
    model: "mimo-v2.6-flash-free",
    messages: [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.3,
    top_p: 0.9,
    stop: ["\n"],
    max_tokens: 128,
    response_format: { type: "json_object" },
  }
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)

  assert.deepEqual(body.messages, payload.messages)
  assert.equal(body.temperature, 0.3)
  assert.equal(body.top_p, 0.9)
  assert.deepEqual(body.stop, ["\n"])
  assert.equal(body.max_tokens, 128)
  assert.deepEqual(body.response_format, { type: "json_object" })
  assert.equal(body.model, "mimo-v2.6-flash-free")
})

test("用户自带工具时保留用户定义，并沿用用户的 tool_choice", () => {
  const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object" } } }
  const body = JSON.parse(
    buildUpstreamRequest(
      { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [weather], tool_choice: "auto" },
      "ses_x",
    ).body,
  )
  const names = body.tools.map((tool) => tool.function.name)
  assert.ok(names.includes("get_weather") && names.includes("bash") && names.includes("read"))
  assert.equal(body.tool_choice, "auto")

  // 用户自带 bash 时不能被门禁版本覆盖
  const custom = { type: "function", function: { name: "bash", description: "mine", parameters: { type: "object" } } }
  const replaced = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [custom] }, "ses_x")
      .body,
  )
  assert.equal(replaced.tools.find((tool) => tool.function.name === "bash").function.description, "mine")
  assert.equal(replaced.tools.filter((tool) => tool.function.name === "bash").length, 1)
})

test("max_tokens 缺省时才补默认值，用户显式传 0 之外的值不覆盖", () => {
  const explicit = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], max_tokens: 7 }, "ses_x").body)
  assert.equal(explicit.max_tokens, 7)

  const fallback = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [] }, "ses_x").body)
  assert.equal(fallback.max_tokens, 32000)

  const completion = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [], max_completion_tokens: 9 }, "ses_x").body,
  )
  assert.equal(completion.max_completion_tokens, 9)
  assert.equal(completion.max_tokens, undefined, "已有 max_completion_tokens 时不应再补 max_tokens")
})

test("模型白名单只放行 big-pickle 与 -free 结尾", () => {
  assert.equal(isAllowedModelId("big-pickle"), true)
  assert.equal(isAllowedModelId("mimo-v2.6-flash-free"), true)
  assert.equal(isAllowedModelId("gpt-6-astra"), false)
  assert.equal(isAllowedModelId("-free"), true)
  assert.equal(isAllowedModelId(""), false)
  assert.equal(isAllowedModelId(null), false)
})

test("session 符合上游格式且同一使用者复用直到过期", () => {
  const user = "user-a"
  const first = getSession(user)
  assert.match(first, /^ses_[0-9a-f]{26}$/)
  assert.equal(getSession(user), first, "同一使用者应复用 session")
  assert.notEqual(getSession("user-b"), first)
})

test("门禁工具定义稳定且不可被模型当成真实工具", () => {
  const tool = gateTool("bash")
  assert.equal(tool.type, "function")
  assert.equal(tool.function.name, "bash")
  assert.deepEqual(tool.function.parameters, { type: "object", properties: {} })
  assert.match(tool.function.description, /do not call/i)
})
