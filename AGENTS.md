# AGENTS.md

给维护者和 AI 看的开发细节。用户文档在 [README.md](README.md)。当前版本 `4.0.0`。

## 架构

```
cmd/oc2api/        入口：默认 HTTP 服务；-stdio 起 stdio JSON-RPC（Vercel 用）
internal/config    环境变量与版本号
internal/zen       uTLS 传输（Bun ClientHello）、上游请求、ses_ 会话、模型列表
internal/shape     官方 system 提示词 + 工具集整形（oc2api_ 改名、32k 上限）
internal/chat      整形 → 上游 → 非流式聚合与兜底重试
internal/protocol  SSE 解析、聚合、[DONE]/错误语义、内置工具过滤
internal/httpapi   本地/Docker HTTP 入口（/、/health、/ip、/v1/*）
internal/rpc       JSON-RPC 2.0 over stdio（Vercel 薄层用）
api/index.js       Vercel 薄层：路由、鉴权、SSE 翻译、spawn Go 二进制
scripts/build-go.sh Vercel 构建期交叉编译 linux/amd64 到 bin/
```

依赖方向单向：`config → zen/shape → chat → protocol → httpapi/rpc`。

## 为什么必须用 uTLS

免费层按**传输层指纹**识别客户端。同一份请求体、同一个出口 IP 下实测：

| 运行时 | 结果 |
| --- | --- |
| Node（undici/OpenSSL） | 429 `FreeUsageLimitError` |
| curl（OpenSSL，HTTP/1.1 与 h2 都试过） | 429 |
| Cloudflare Workers（真实边缘出口） | 429 |
| Bun（BoringSSL，官方客户端） | 200 |

所以 `internal/zen` 用 `refraction-networking/utls` 复刻 Bun 的 ClientHello
（JA4 `t13d1713h1`，无 GREASE、ALPN 只有 `http/1.1`、首个 key share 是
`X25519MLKEM768`）。改这里要重新抓 Bun 的包验证，不能凭直觉加扩展。

## 免费层的形状要求

请求体必须同时满足，缺一项就是 429：

- **system 提示词**：现在是最小版（874 字节，`internal/shape/assets/prompt.txt`），没有
  Code Mode / 工具说明。`<env>` 块**不能整块删**（429），至少要保留
  `Working directory`；`Platform`、`Is directory a git repo`、`Workspace root folder`
  都可以删（均已实测）。
- **工作目录写 `./`**：绝对路径会让模型以为自己能访问那个目录。由 `shape.go` 的
  `workdir` 常量填充。
- **`tools` 不能为空**（去掉或置空直接 429）。实测**只发 `read` 一项就够**，所以现在只发
  read，其余官方工具不发送。
- `stream: true` + `stream_options.include_usage`；`stream:false` 也 429，非流式在本地聚合。
- `max_completion_tokens: 32000`。
- `ses_` 会话 id：12 位倒序十六进制时间戳 + 14 位 base62。时间戳取当前毫秒，
  **毫秒内序号从 1 开始**（序号 0 会落到 0xFFF 被拒）。

提示词占位符只有四个：`{{MODEL}}`、`{{MODELNAME}}`、`{{DATE}}`、`{{WORKDIR}}`。

请求头里 `x-opencode-project` 用固定哈希即可；`b3` / `traceparent` 不是必需。

## 工具整形

1. 客户端声明的工具改名 `oc2api_<sanitized>`（`internal/shape` 的 `ToolPrefix`），
   响应侧按同一前缀还原；
2. 官方工具只发 `read`，描述换成 "Reserved for the host runtime; do not call or select
   this function."；
3. 客户端没声明任何工具时，system 末尾补一句“不要调用工具”；
4. 兜底：`internal/protocol` 按 `index` 缓冲工具调用，确认不是 `oc2api_` 的整条丢弃，
   `finish_reason` 从 `tool_calls` 回退 `stop`；非流式没有正文时带更强提示重试一次。

## Vercel 为什么是「薄 Node + Go 二进制」

Vercel 的 Go runtime 会**缓冲整段响应**：用 700ms 间隔 flush 的测试函数，客户端 5 帧在
同一秒到达（服务端时间戳跨了 3 秒）。SSE 出不来，所以：

- `scripts/build-go.sh` 构建期下载 Go 工具链、交叉编译 `linux/amd64` 到 `bin/`；
- `api/index.js` 首个请求把二进制拷到 `/tmp`、`chmod +x`、`spawn -stdio` 后常驻；
- 每条请求带自增 `id`，Go 侧按 id 回通知，Node 用 `Map<id, handler>` 分发，并发流不串；
- `vercel.json` 用 `includeFiles: bin/**` 把二进制打进函数。

注意：Vercel 只要配了 `buildCommand` 就要求静态输出目录非空，所以构建脚本会生成
`public/robots.txt`（**不能放 index.html**，否则 `/` 会被静态文件抢走，拿不到和
`/health` 同构的 JSON）。仓库里没有 `public/`。

## 测试

```bash
go test ./...              # 单元测试（整形、响应过滤、错误语义）
go vet ./...
golangci-lint run ./...    # 配置见 .golangci.yml
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/oc2api
```

改动之后跑一次真实冒烟（`internal/chat/live_test.go`）：一次流式 + 自定义工具的请求，
再用同一段对话追问一轮，两次都 200 且流里有正文和 `[DONE]` 即通过。

```bash
OC2API_LIVE_TEST=1 go test ./internal/chat -run Live -v
```

默认跳过，因为消耗免费额度。额度用尽时上游回 429，和“形态不对”的 429 文案相同：
403 `FreeTierError` 才是形态问题，429 且带 `Retry-After` 通常是额度或网络被限。
本机没额度时，同样的两轮请求可以直接打部署实例验证。

## 已知限制 / 后续

- **会话未复用**：HTTP 入口每次请求都新造 `ses_`，多轮对话命中不了上游 prompt 缓存
  （`chat.UpstreamWithSession` 已经支持复用，只差按对话做种子 + TTL）。
- **流式没有空闲超时**：只有建连和响应头超时，上游半死不活时会挂到平台上限。
- **薄层没有 RPC 超时**：Go 子进程卡住时 Node 会一起等。
- **测试覆盖**：`internal/httpapi`、`internal/rpc` 和 `api/index.js` 还没有测试。
