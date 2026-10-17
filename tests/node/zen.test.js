import assert from "node:assert/strict"
import test from "node:test"

import { areToolsDisabled, buildUpstreamRequest, gateTool, isAllowedModelId, getSession } from "../../server/zen.js"

test("免费层必要条件：UA、session、门禁工具、强制流式", () => {
  const request = buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }, "ses_test")
  const body = JSON.parse(request.body)

  assert.equal(body.stream, true, "stream:false 会被上游 403，必须强制 true")
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(request.headers["User-Agent"], "opencode/latest/2.0.29/cli")
  assert.equal(request.headers.Authorization, "Bearer public")
  assert.equal(request.headers["x-opencode-client"], "cli")
  assert.equal(request.headers["x-opencode-project"], "global")
  assert.equal(request.headers["x-opencode-request"], undefined, "V2 不发送旧版非标准 request ID，会导致 403")
  for (const header of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "X-Session-Id"]) {
    assert.equal(request.headers[header], "ses_test", `${header} 必须复用同一会话`)
  }

  const names = body.tools.map((tool) => tool.function.name)
  assert.deepEqual(names, ["read"], "上游只要求 read 门禁，多余的 shell 会与客户端工具重名")
  assert.equal(body.tool_choice, undefined, "V2 不接受显式 none，禁用语义由响应层强制执行")
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

test("危险键名不转发给上游，同时不影响正常字段", () => {
  // JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，展开后会原样进 body。
  // 实测不会污染本地原型，但这类字段没有任何透传价值，一律剥掉。
  const payload = JSON.parse(
    '{"model":"big-pickle","messages":[],"temperature":0.5,' +
      '"__proto__":{"polluted":"yes"},"constructor":{"x":1},"prototype":{"y":2}}',
  )
  const raw = buildUpstreamRequest(payload, "ses_x").body
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.ok(!raw.includes(`"${key}"`), `${key} 不应出现在上游 body 里`)
  }
  const body = JSON.parse(raw)
  assert.equal(body.temperature, 0.5, "正常字段必须保留")
  assert.equal(body.model, "big-pickle")
  assert.equal(Object.prototype.polluted, undefined, "本地原型不能被污染")
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
  assert.ok(names.includes("oc2api_get_weather") && names.includes("read"))
  assert.equal(body.tool_choice, "auto")

  // 同名客户端工具通过别名保留，不再占用或被覆盖成门禁定义。
  const custom = { type: "function", function: { name: "read", description: "mine", parameters: { type: "object" } } }
  const request = buildUpstreamRequest(
    { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [custom] },
    "ses_x",
  )
  const replaced = JSON.parse(request.body)
  const clientRead = replaced.tools.find((tool) => tool.function.name === "oc2api_read")
  assert.match(clientRead.function.description, /mine/)
  assert.deepEqual(clientRead.function.parameters, custom.function.parameters)
  assert.equal(request.toolAliases.get("oc2api_read"), "read")
  assert.deepEqual(
    replaced.tools.find((tool) => tool.function.name === "read"),
    gateTool("read"),
  )
  assert.equal(replaced.tools.filter((tool) => tool.function.name === "read").length, 1)
})

test("同名 read 保留客户端 schema，别名不撞已有工具，历史与指定选择同步映射", () => {
  const read = Object.freeze({
    type: "function",
    function: Object.freeze({
      name: "read",
      description: "Read client file",
      strict: true,
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    }),
  })
  const shell = {
    type: "function",
    function: { name: "shell", parameters: { type: "object", properties: { script: { type: "string" } } } },
  }
  const existing = ["oc2api_read", "oc2api_read_1"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object" } },
  }))
  const payload = {
    model: "big-pickle",
    messages: [
      { role: "user", content: "Use read and shell" },
      {
        role: "assistant",
        tool_calls: [
          { id: "A", type: "function", function: { name: "read", arguments: '{"file_path":"README.md"}' } },
          { id: "B", type: "function", function: { name: "shell", arguments: '{"script":"echo OK"}' } },
        ],
      },
      { role: "tool", tool_call_id: "A", content: "file content" },
      { role: "tool", tool_call_id: "B", content: "OK" },
      { role: "assistant", function_call: { name: "read", arguments: '{"file_path":"README.md"}' } },
      { role: "function", name: "read", content: "legacy result" },
    ],
    tools: [read, shell, ...existing],
    tool_choice: { type: "function", function: { name: "read" } },
  }
  const snapshot = JSON.stringify(payload)
  const request = buildUpstreamRequest(payload, "ses_x")
  const body = JSON.parse(request.body)
  assert.deepEqual(Object.fromEntries(request.toolAliases), {
    oc2api_shell: "shell",
    oc2api_read_2: "read",
    oc2api_oc2api_read: "oc2api_read",
    oc2api_oc2api_read_1: "oc2api_read_1",
  })
  assert.equal(new Set(body.tools.map((tool) => tool.function.name)).size, body.tools.length)
  assert.deepEqual(
    body.tools.find((tool) => tool.function.name === "oc2api_read_2").function.parameters,
    read.function.parameters,
  )
  assert.equal(body.tools.find((tool) => tool.function.name === "oc2api_read_2").function.strict, true)
  assert.deepEqual(
    body.tools.find((tool) => tool.function.name === "read"),
    gateTool("read"),
  )
  assert.equal(body.tool_choice.function.name, "oc2api_read_2")
  assert.deepEqual(
    body.messages[1].tool_calls.map((call) => call.function.name),
    ["oc2api_read_2", "oc2api_shell"],
  )
  assert.deepEqual(
    body.messages[1].tool_calls.map((call) => call.id),
    ["A", "B"],
  )
  assert.deepEqual(body.messages.slice(2, 4), payload.messages.slice(2, 4))
  assert.equal(body.messages[4].function_call.name, "oc2api_read_2")
  assert.equal(body.messages[5].name, "oc2api_read_2")
  assert.equal(JSON.stringify(payload), snapshot, "不能修改调用者的定义、历史或参数")
  assert.ok(request.clientToolNames.includes("oc2api_oc2api_read"))
  assert.ok(!request.clientToolNames.includes("read"))
})

test("role:tool 消息一律不发 name：GLM 会 400，且该字段在 OpenAI 规范里可选", () => {
  // 实测：glm-5.3-flash-free 直接回
  //   `[unsupported_parameter] messages[2]: "name" is not supported by this endpoint`
  // 而 deepseek-v4.1-flash-free 容忍它。因为 tool_call_id 已能定位工具结果，
  // 所以统一剥掉 name，两种模型都能正常工作。
  const glob = {
    type: "function",
    function: { name: "glob", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
  }
  const payload = {
    model: "glm-5.3-flash-free",
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"./"}' } }],
      },
      // 客户端回填工具结果时常带 name（Claude Code / DSH 等都这么发）
      { role: "tool", tool_call_id: "c1", name: "glob", content: "a.js b.js" },
      // 即使名字不在别名表里，也不能漏给上游
      { role: "tool", tool_call_id: "c2", name: "unknown_tool", content: "x" },
    ],
    tools: [glob],
  }
  const snapshot = JSON.stringify(payload)
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)

  for (const message of body.messages.filter((m) => m.role === "tool")) {
    assert.ok(!("name" in message), "role:tool 消息不应带 name")
    assert.ok(typeof message.tool_call_id === "string" && message.tool_call_id, "tool_call_id 必须保留")
  }
  // 历史里的工具调用本身仍要按别名改写，不受影响。
  assert.equal(body.messages[1].tool_calls[0].function.name, "oc2api_glob")
  assert.equal(JSON.stringify(payload), snapshot, "不能修改调用者的消息对象")
})

test("没有客户端工具时也剥掉 role:tool 的 name", () => {
  // 归一化必须无条件执行：早期实现只在存在客户端工具时才改写消息，
  // 导致纯文本回填（无 tools）场景下 name 照样漏给上游。
  const payload = {
    model: "glm-5.3-flash-free",
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "c1", name: "glob", content: "result" },
    ],
  }
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
  const toolMessage = body.messages.find((m) => m.role === "tool")
  assert.ok(!("name" in toolMessage))
  assert.equal(toolMessage.tool_call_id, "c1")
  assert.equal(toolMessage.content, "result")
})

test("所有客户端工具包括 edit/write 都隔离，允许列表选择与长名字保持合法映射", () => {
  const longA = "a".repeat(64)
  const longB = "a".repeat(63) + "b"
  const names = ["read", "shell", "edit", "write", "glob", "grep", "get_weather", longA, longB]
  const tools = names.map((name) => ({
    type: "function",
    function: {
      name,
      description: "Client definition",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
    },
  }))
  const payload = {
    model: "big-pickle",
    messages: [],
    tools,
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [
        { type: "function", name: "edit" },
        { type: "function", function: { name: "write" } },
      ],
    },
  }
  const request = buildUpstreamRequest(payload, "ses_x")
  const body = JSON.parse(request.body)
  assert.equal(request.toolAliases.size, names.length)
  assert.equal(new Set(body.tools.map((tool) => tool.function.name)).size, body.tools.length)
  for (const tool of body.tools.slice(0, tools.length)) {
    assert.match(tool.function.name, /^[A-Za-z0-9_-]{1,64}$/)
    const original = request.toolAliases.get(tool.function.name)
    assert.ok(names.includes(original))
    assert.notEqual(tool.function.name, original)
    assert.deepEqual(
      tool.function.parameters,
      tools.find((source) => source.function.name === original).function.parameters,
    )
  }
  assert.equal(body.tool_choice.tools[0].name, "oc2api_edit")
  assert.equal(body.tool_choice.tools[1].function.name, "oc2api_write")
  assert.equal(body.tool_choice.mode, "auto")
  assert.deepEqual(body.tools.slice(-1), [gateTool("read")])
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
  // 上游只认这种形状：ses_ + 12 位十六进制 + 14 位 base62，共 30 字符
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(first.length, 30)
  assert.equal(getSession(user), first, "同一使用者应复用 session")
  assert.notEqual(getSession("user-b"), first)
})

test("门禁工具用官方 read 名字与参数 schema，描述为旧版禁止调用文案", () => {
  const tool = gateTool("read")
  assert.equal(tool.type, "function")
  assert.equal(tool.function.name, "read")
  assert.equal(
    tool.function.description,
    "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.",
  )
  assert.equal(tool.function.parameters.properties.path.type, "string")
  assert.deepEqual(tool.function.parameters.required, ["path"])
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.equal(tool.function.strict, false)
  assert.equal(tool.function.parameters.properties.offset.minimum, 0)
})

test("禁用工具时不透传 none 或用户工具，也不修改用户消息", () => {
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }]
  for (const input of [{}, { tools: [] }, { tools, tool_choice: "none" }]) {
    const payload = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], ...input }
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.equal(areToolsDisabled(payload), true)
    assert.equal(body.tool_choice, undefined)
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ["read"],
    )
    assert.deepEqual(body.messages, payload.messages)
  }
  for (const choice of [undefined, "auto", "required", { type: "function", function: { name: "weather" } }]) {
    const payload = { model: "big-pickle", messages: [], tools, tool_choice: choice }
    assert.equal(areToolsDisabled(payload), false)
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.equal(body.tools[0].function.name, "oc2api_weather")
    assert.deepEqual(body.tools[0].function.parameters, tools[0].function.parameters)
    assert.deepEqual(
      body.tool_choice,
      typeof choice === "object" ? { ...choice, function: { name: "oc2api_weather" } } : choice,
    )
  }
})

test("reasoningEffort 别名恢复上游 snake_case，snake_case 优先", () => {
  for (const [input, expected] of [
    [{ reasoningEffort: "none" }, "none"],
    [{ reasoningEffort: "high" }, "high"],
    [{ reasoning_effort: "low", reasoningEffort: "high" }, "low"],
    [{ reasoning_effort: null, reasoningEffort: "medium" }, "medium"],
    [{ reasoning_effort: "" }, undefined],
    [{}, undefined],
  ]) {
    const body = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], ...input }, "ses_x").body)
    assert.equal(body.reasoning_effort, expected)
    assert.equal(body.reasoningEffort, undefined)
  }
})

test("session 滑动过期：活跃时复用，空闲满 30 分钟换新", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1 })
  const first = getSession("expiry-test")
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first)
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first, "按空闲时间而不是创建时间过期")
  t.mock.timers.tick(30 * 60 * 1000)
  assert.notEqual(getSession("expiry-test"), first)
})

test("buildUpstreamRequest 不修改用户工具、消息或参数原对象", () => {
  const weather = Object.freeze({
    type: "function",
    function: Object.freeze({ name: "weather", parameters: { type: "object" } }),
  })
  const payload = Object.freeze({
    model: "big-pickle",
    tools: Object.freeze([weather]),
    messages: Object.freeze([{ role: "user", content: "hi" }]),
    max_tokens: 0,
  })
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
  assert.equal(payload.tools.length, 1)
  assert.equal(body.tools.length, 2)
  assert.equal(body.max_tokens, 0)
  assert.deepEqual(body.messages, payload.messages)
})
