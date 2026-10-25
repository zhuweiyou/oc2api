# AGENTS.md

给维护者和 AI 看的开发细节。用户文档在 [README.md](README.md)。

## 架构

```
cmd/oc2api/        入口：默认 HTTP 服务；-stdio 起 stdio JSON-RPC（Vercel 用）
internal/config    环境变量与版本号
internal/zen       uTLS 传输（Bun ClientHello）、上游请求、会话 id、模型列表
internal/shape     官方 system 提示词 + 工具集整形（clint_ 改名、32k 上限）
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
| Cloudflare Workers（边缘真实出口） | 429 |
| Bun（BoringSSL，官方客户端） | 200 |

所以 `internal/zen` 用 `refraction-networking/utls` 复刻 Bun 的 ClientHello
（JA4 `t13d1713h1`，无 GREASE、ALPN 只有 `http/1.1`、首个 key share 是
`X25519MLKEM768`）。改这里要重新抓 Bun 的包验证，不能凭直觉加扩展。

## 免费层的形状要求

请求体必须同时满足（缺一项就 429）：

- 官方 system 提示词（`internal/shape/assets/prompt.txt`，运行期填模型名/日期/环境块）；
- 官方工具集（`internal/shape/assets/tools.json`，12 个工具）；**去掉 tools 或置空直接 429**；
- `stream: true` + `stream_options.include_usage`；`stream:false` 也 429，非流式在本地聚合；
- `max_completion_tokens: 32000`；
- `ses_` + 12 位倒序十六进制时间戳 + 14 位 base62 的会话 id。时间戳取当前毫秒，
  **毫秒内序号从 1 开始**（序号 0 会落到 0xFFF 被拒）。

请求头里的 `x-opencode-project` 用固定哈希即可；`b3`/`traceparent` 不是必需。

## 工具整形

免费层要工具集，客户端却没有这些工具，所以：

1. 客户端工具改名 `clint_<sanitized>`（`internal/shape`），响应侧还原；
2. 官方工具的描述统一换成 "Reserved for the host runtime; do not call or select this
   function."——实测这样模型就不再选中它们，且不影响免费层校验；
3. 客户端没声明工具时，system 末尾再补一句"不要调用工具"；
4. 兜底：`internal/protocol` 按 `index` 缓冲工具调用，确认不是 `clint_` 的整条丢弃，
   `finish_reason` 从 `tool_calls` 回退 `stop`；非流式没有正文时带更强提示重试一次。

## Vercel 为什么是「薄 Node + Go 二进制」

Vercel 的 Go runtime 会**缓冲整段响应**：用 700ms 间隔 flush 的测试函数，客户端
5 帧在同一秒到达（服务端时间戳跨了 3 秒）。SSE 出不来，所以：

- `scripts/build-go.sh` 构建期下载 Go 工具链、交叉编译 `linux/amd64` 到 `bin/`；
- `api/index.js` 首个请求把二进制拷到 `/tmp`、`chmod +x`、`spawn -stdio` 后常驻；
- 每条请求带自增 `id`，Go 侧按 id 回通知，Node 用 `Map<id, handler>` 分发，并发流不串；
- `vercel.json` 用 `includeFiles: bin/**` 把二进制打进函数。

注意：Vercel 只要配了 `buildCommand` 就要求静态输出目录非空，所以构建脚本会生成
`public/robots.txt`（**不能放 index.html**，否则 `/` 会被静态文件抢走，拿不到和
`/health` 同构的 JSON）。仓库里没有 `public/`。

## 测试

离线单元测试（整形、响应过滤、错误语义）：

```bash
go test ./...
go vet ./...
golangci-lint run ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/oc2api
```

lint 配置在 `.golangci.yml`：标准集（errcheck / govet / ineffassign / staticcheck / unused）加 misspell。

改动之后跑一次真实冒烟（`internal/chat/live_test.go`）：一次流式 + 自定义工具的请求，
再用同一段对话追问一轮，两次都 200 且流里有正文和 `[DONE]` 即通过。

```bash
OC2API_LIVE_TEST=1 go test ./internal/chat -run Live -v
```

默认跳过，因为它消耗免费额度。额度用尽时上游回 429，和"形态不对"的 429 文案相同：
403 `FreeTierError` 才是形态问题，429 且带 `Retry-After` 通常是额度或网络被限。
本地 IP 没额度时，同样的两轮请求可以直接打部署实例验证（`curl -N`，第二轮把上一轮的
assistant 消息带回 messages）。
