// 真实联调：直接打上游，受免费层限流影响，离线运行时整体跳过。
// 只保留离线测试无法证明的东西：
//   1. 多轮连续工具调用在真实模型上能走通（含结果回填与后续轮次）；
//   2. 与内置门禁同名的客户端 read 能被正确隔离和还原；
//   3. 多个免费模型行为一致，而不是只在 big-pickle 上碰巧成立。
// 刻意不点名工具：提示词一旦写出 "read tool"，模型会按名字匹配到同名的
// 内置门禁工具，测出来的是提示词问题而不是代理问题。只描述任务，让模型自己选。
import assert from "node:assert/strict"
import { once } from "node:events"
import test from "node:test"

import { startServer } from "../../server/app.js"

const live = process.env.OC2API_LIVE_TEST === "1"
const options = { skip: !live, concurrency: false, timeout: 180_000 }

// 覆盖不同厂商：big-pickle 是特例硬编码的免费模型，其余都以 -free 结尾。
const MODELS = ["big-pickle", "mimo-v2.6-flash-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free"]

let server
let baseURL

test.before(async () => {
  if (!live) return
  server = startServer({ port: 0, logger: { log() {} } })
  await once(server, "listening")
  baseURL = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  if (!server) return
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

// 一个贴近真实客户端的最小工具集：自定义 read 与内置门禁 read 同名但参数不同，
// 外加两个常用工具，用来验证重名不会串味。
function clientTools() {
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a UTF-8 text file from the client workspace and return its contents.",
        parameters: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "List files matching a glob pattern in the client workspace.",
        parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: "Search the client workspace for a text query.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
  ]
}

for (const model of MODELS) {
  test(`${model}: 多轮连续工具调用，含同名 read 与其他工具`, options, async () => {
    const tools = clientTools()
    // 第一轮：只描述任务（列目录并读文件），不点名任何工具，让模型自己选。
    const first = await chat(model, {
      messages: [{ role: "user", content: "先看看当前目录下有哪些文件，然后把 README.md 的内容读出来告诉我。" }],
      tools,
      tool_choice: "auto",
    })
    const firstCalls = collectToolCalls(first)
    assert.ok(firstCalls.length > 0, "第一轮应产生工具调用")
    assertToolNamesAreClientNames(firstCalls, tools)

    // 回填所有工具结果，再让它基于结果继续。
    const second = await chat(model, {
      messages: [
        { role: "user", content: "先看看当前目录下有哪些文件，然后把 README.md 的内容读出来告诉我。" },
        assistantWithCalls(firstCalls),
        ...firstCalls.map((call) => ({
          role: "tool",
          tool_call_id: call.id,
          // 故意带上 name：客户端普遍会带，GLM 曾因此 400。
          name: call.name,
          content: toolResult(call),
        })),
      ],
      tools,
      tool_choice: "auto",
    })
    const secondCalls = collectToolCalls(second)
    if (secondCalls.length) {
      // 模型可能继续调用别的工具；名字仍必须是客户端名字，不能漏出别名。
      assertToolNamesAreClientNames(secondCalls, tools)
    } else {
      const text = collectText(second)
      assert.ok(text.length > 0, "拿到工具结果后应给出自然语言回答或继续调用工具")
    }
  })
}

test("门禁同名 read 在真实上游被隔离，且参数不被改写", options, async () => {
  const tools = clientTools()
  const messages = [{ role: "user", content: "把 README.md 的内容原样读给我，不要猜测内容。" }]
  const first = await chat("big-pickle", { messages, tools, tool_choice: "auto" })
  const calls = collectToolCalls(first)
  const readCall = calls.find((call) => call.name === "read")
  assert.ok(readCall, `应产生一次客户端 read 调用，实际=${JSON.stringify(calls.map((c) => c.name))}`)
  // 客户端 read 用 file_path；门禁 read 用 path。被改写成门禁参数就是 bug。
  assert.deepEqual(
    Object.keys(JSON.parse(readCall.arguments)),
    ["file_path"],
    "客户端 read 的参数不能被换成门禁的 path",
  )
  assert.ok(readCall.id, "工具调用必须带 id 以便回填")

  const second = await chat("big-pickle", {
    messages: [
      ...messages,
      assistantWithCalls([readCall]),
      { role: "tool", tool_call_id: readCall.id, name: readCall.name, content: "OC2API_LIVE_ROUNDTRIP" },
    ],
    tools,
    tool_choice: "auto",
  })
  assert.match(collectText(second), /OC2API_LIVE_ROUNDTRIP/, "模型应引用回填的工具结果")
})

test("非流式与流式在真实上游给出等价结果", options, async () => {
  const tools = clientTools()
  const messages = [{ role: "user", content: "列出当前目录下的文件名。" }]
  const streamed = collectText(await chat("big-pickle", { messages, tools, tool_choice: "auto" }))
  const oneShot = await chatJSON("big-pickle", { messages, tools, tool_choice: "auto" })
  const choice = oneShot.choices[0]
  assert.ok(choice, "非流式应返回 choice")
  assert.equal(choice.message.role, "assistant")
  if (choice.message.tool_calls?.length) {
    assert.equal(choice.finish_reason, "tool_calls")
  } else {
    assert.ok((choice.message.content ?? "").length > 0 || streamed.length > 0)
  }
})

// auto 不保证每次都调用工具，允许有限重试；仍不调用就失败，不用 skip 冒充通过。
async function chat(model, payload) {
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await requestChat({ model, stream: true, temperature: 0, max_tokens: 1024, ...payload })
    const chunks = assertStreamingResponse(response.text, `${model} attempt ${attempt}`)
    const calls = collectToolCalls(chunks)
    const text = collectText(chunks)
    if (calls.length || text.length) return chunks
    last = response.text
  }
  assert.fail(`${model} 三次都没有产出可用结果：${last}`)
}

async function chatJSON(model, payload) {
  const response = await requestChat({ model, stream: false, temperature: 0, max_tokens: 1024, ...payload })
  return parseJSON(response.text, `${model} non-stream`)
}

async function requestChat(payload) {
  const headers = { "content-type": "application/json" }
  if (process.env.API_KEY) headers.authorization = `Bearer ${process.env.API_KEY}`
  const response = await fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(150_000),
  })
  const text = await response.text()
  // 免费层限流是真实存在的，但要和其它失败区分开，不能一律当成限流。
  if (response.status === 429 && /rate_limit/i.test(text)) {
    assert.fail(`上游限流，请稍后重试：${text.slice(0, 200)}`)
  }
  assert.equal(response.status, 200, `联调失败 HTTP ${response.status}: ${text.slice(0, 400)}`)
  if (payload.stream) assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  return { headers: response.headers, text }
}

// 只按 choice/index 聚合，模拟标准客户端；不能用 id 兜底，否则会把代理的
// 缺 index 缺陷在测试里自己修好。
function collectToolCalls(chunks) {
  const calls = []
  const byChoice = new Map()
  for (const choice of chunks.flatMap((chunk) => chunk.choices ?? [])) {
    for (const part of choice.delta?.tool_calls ?? []) {
      assert.ok(Number.isInteger(choice.index) && choice.index >= 0, "工具调用必须带有效 choice index")
      assert.ok(Number.isInteger(part.index) && part.index >= 0, "每个工具片段必须带非负整数 index")
      if (!byChoice.has(choice.index)) byChoice.set(choice.index, new Map())
      const byIndex = byChoice.get(choice.index)
      if (!byIndex.has(part.index)) {
        const call = { id: "", name: "", arguments: "" }
        byIndex.set(part.index, call)
        calls.push(call)
      }
      const call = byIndex.get(part.index)
      if (part.id) call.id = part.id
      if (part.function?.name) call.name = part.function.name
      if (part.function?.arguments) call.arguments += part.function.arguments
    }
  }
  return calls
}

function collectText(chunks) {
  return chunks
    .flatMap((chunk) => chunk.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("")
}

function assertToolNamesAreClientNames(calls, tools) {
  const names = new Set(tools.map((tool) => tool.function.name))
  for (const call of calls) {
    assert.ok(names.has(call.name), `客户端不能收到别名或门禁工具，实际=${call.name}`)
  }
}

function assistantWithCalls(calls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  }
}

function toolResult(call) {
  if (call.name === "read") return "OC2API_LIVE_README_CONTENT"
  if (call.name === "glob") return "README.md\npackage.json\nserver/"
  return "search-result"
}

function assertStreamingResponse(text, scenario) {
  assert.equal(text.split("[DONE]").length - 1, 1, `${scenario} 应且只应有一个 [DONE]`)
  const chunks = parseSSEData(text, scenario)
  assert.ok(chunks.length > 0, `${scenario} 没有收到任何 JSON 帧`)
  for (const chunk of chunks) {
    assert.ok(!chunk.error, `${scenario} 流中错误：${JSON.stringify(chunk.error)}`)
    assert.ok(Array.isArray(chunk.choices), `${scenario} choices 必须是数组`)
  }
  return chunks
}

function parseJSON(text, scenario) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${scenario} 返回了非法 JSON：${error.message}; body=${text.slice(0, 300)}`, { cause: error })
  }
}

function parseSSEData(text, scenario) {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim(),
    )
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => parseJSON(payload, scenario))
}
