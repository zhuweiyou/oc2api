// Cloudflare Workers 的传输适配层。
//
// 业务逻辑全部来自 server/（与本地 Node / Vercel 同一份实现）：
//   - server/zen.js     上游请求构造、会话、模型列表
//   - server/openai.js  事件解析、帧编排（streamFrames / aggregateChunks）、错误语义
// 这里只负责把「帧」写进 ReadableStream，以及把「聚合结果」包成 Response。
// 因此本文件不应出现任何上游字段改写逻辑——要改就改 server/。
import {
  aggregateChunks,
  readErrorBody,
  streamFailure,
  streamFrames,
  upstreamFailure,
  upstreamStatus,
} from "../../server/openai.js"

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

const encoder = new TextEncoder()

// 与 Node 版 `send` 一致：字符串载荷（只有 "[DONE]"）原样写，其余序列化成 JSON。
function frame(payload) {
  return encoder.encode(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  })
}

// 把 async generator 变成 pull 驱动的 ReadableStream：
// 下游不消费就不读上游（背压），客户端断开时 cancel 会调用 generator.return。
function iteratorStream(iterator) {
  let done = false
  return new ReadableStream({
    async pull(controller) {
      if (done) return
      try {
        const step = await iterator.next()
        if (step.done) {
          done = true
          controller.close()
          return
        }
        controller.enqueue(step.value)
      } catch (error) {
        done = true
        controller.error(error)
      }
    },
    async cancel(reason) {
      done = true
      await iterator.return?.(reason)
    },
  })
}

export async function respondStream(upstream, ctx) {
  if (!upstream.ok) {
    const status = upstreamStatus(upstream)
    return jsonResponse(upstreamFailure(status, await readErrorBody(upstream, ctx)), status)
  }
  if (!upstream.body) return jsonResponse(streamFailure("Empty response from upstream"), 502)

  const reader = upstream.body.getReader()
  const frames = streamFrames(reader, ctx)

  // 先取第一帧再提交响应头：建连阶段就失败时还能退回普通 JSON 错误，
  // 与 Node 版「首个有效事件之前不提交 SSE 头」的语义一致。
  let first
  try {
    first = await frames.next()
  } catch (error) {
    await reader.cancel().catch(() => {})
    return jsonResponse(streamFailure(error?.message || "Upstream stream error"), 502)
  }
  if (first.done) {
    await reader.cancel().catch(() => {})
    return jsonResponse(streamFailure("Empty response from upstream"), 502)
  }

  const body = iteratorStream(
    (async function* () {
      try {
        yield frame(first.value)
        for await (const payload of frames) {
          yield frame(payload)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    })(),
  )

  return new Response(body, {
    status: upstream.status,
    headers: { ...SSE_HEADERS, "x-request-id": ctx.requestId },
  })
}

export async function respondJson(upstream, ctx) {
  if (!upstream.ok) {
    const status = upstreamStatus(upstream)
    return jsonResponse(upstreamFailure(status, await readErrorBody(upstream, ctx)), status)
  }
  if (!upstream.body) return jsonResponse(streamFailure("Empty response from upstream"), 502)

  const reader = upstream.body.getReader()
  try {
    const result = await aggregateChunks(reader, ctx)
    return jsonResponse(result, upstream.status, { "x-request-id": ctx.requestId })
  } catch (error) {
    await reader.cancel().catch(() => {})
    return jsonResponse(streamFailure(error?.message || "Upstream stream error"), 502)
  }
}
