# AGENTS.md

给维护者和 AI 看的开发细节。用户文档在 [README.md](README.md)。

## 架构

```
cmd/oc2api/        入口：默认 HTTP 服务；-stdio 起 stdio JSON-RPC（Vercel 用）
internal/config    环境变量与版本号：Load() 读一次并校验，之后靠注入传下去
internal/zen       uTLS 传输（Bun ClientHello）、上游路径与超时、ses_ 会话、模型列表
internal/shape     官方 system 提示词 + 工具集整形（oc2api_ 改名、32k 上限）
internal/proxypool 订阅节点池：Clash/mihomo 解析、启动健康探测、sticky/round_robin 轮换
internal/ipinfo    出口 IP 查询（ipquery / ip-api / 1.1.1.1 trace 并发竞速）
internal/chat      整形 → 上游 → 非流式聚合；带节点池时按策略轮换、失败换节点
internal/protocol  SSE 解析、聚合、[DONE]/错误语义、内置工具过滤
internal/httpapi   本地/Docker HTTP 入口（/、/health、/ip、/v1/*）
internal/rpc       JSON-RPC 2.0 over stdio（Vercel 薄层用）
api/index.js       Vercel 薄层：路由、鉴权、SSE 翻译、spawn Go 二进制
scripts/build-go.sh Vercel 构建期交叉编译 linux/amd64 到 bin/（加 -tags nomihomo）
```

依赖方向：`config → zen/shape → chat → protocol → httpapi/rpc`；`proxypool` 独立，
被 `chat` / `httpapi` 引用，不反向依赖它们。

## 配置怎么传

`internal/config` 是唯一读 `os.Getenv` 的地方（`Load()`，无缓存、无单例）。`main` 启动时
调一次 `config.Load()`，再把 `config.Config` 注入 `zen.New`、`chat.New`、`httpapi.New`、
`rpc.New`；配置了 `PROXY_SUBSCRIPTION_URL` 时还会构造 `proxypool.Pool` 并调 `Pool.Start()`
（启动即拉订阅 + 后台健康探测）。其它包不许再自己读环境变量。校验失败直接 `log.Fatalf`，
不要静默回落。

`ZEN_API_BASE_URL` 只填**站点根**（默认 `https://opencode.ai`），接口路径写在
`internal/zen` 的 `chatPath` / `modelsPath` 常量里（`/inference/v1/chat/completions`、
`/inference/v1/models`，两者实测 200）。上游换路径只改这两行，部署配置不用动。

超时只有一个旋钮 `ZEN_CONNECT_TIMEOUT_MS`（默认 60 秒，1–600000），同时管 TCP 建连、
TLS 握手和等响应头；正文流式读取不设上限。注意：自定义 `DialTLSContext` 之后
`http.Transport.TLSHandshakeTimeout` 不生效，握手超时是在 dial 里自己加 deadline 兜的，
改这里别把 `handshakeCtx` 删了。

## 订阅节点池与双构建

订阅相关逻辑全在 `internal/proxypool`：

- `Pool.Start(ctx)` 在启动阶段拉订阅并后台健康探测（不再等第一次请求）；`PROXY_STRATEGY`
  决定 `sticky`（默认填充，用到不可用才换）或 `round_robin`（轮询）；
- Clash YAML 由 `github.com/metacubex/mihomo/adapter.ParseProxy` 解析，支持
  ss/vmess/vless/trojan/hysteria2/http/socks5；带 `dialer-proxy` 的链式节点会跳过；
- 健康探测只做真实 TLS 握手（`1.1.1.1:443` + `opencode.ai:443`），不消耗上游额度；
  `PROXY_HEALTH_INTERVAL_SECONDS` 定时重试死节点、复检健康节点；
- `PROXY_SUBSCRIPTION_REFRESH_SECONDS` 定时重拉订阅；**新节点先在旧池外探测完再整体切换**，
  失败/为空/新池无健康节点都保留旧池；节点状态按 `Dialer.Key()`（协议+地址+凭据哈希）跨刷新保留；
- `/health` 返回统计与健康节点列表（`?state=` 可切），`/ip` 同时返回直连与代理出口，
  两个出口都由 ipquery / ip-api / 1.1.1.1 trace 并发竞速。

双构建用 `nomihomo` 标签：

- `mihomo.go` 是 `//go:build !nomihomo`，`mihomo_stub.go` 是 `//go:build nomihomo`；
- Vercel `scripts/build-go.sh` 固定 `-tags nomihomo`，二进制约 8MB，只能吃 http/socks5 代理列表；
- 本地 / Docker 默认不加 tag，带内核约 46MB，支持 Clash 全协议；
- Dockerfile 有 `ARG GO_TAGS`，`--build-arg GO_TAGS=nomihomo` 可瘦身。

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

- **system 提示词**：现在是最小版（999 字节，`internal/shape/assets/prompt.txt`），删掉了
  Code Mode 与内置工具目录，只保留一句「只使用请求里提供的工具」。`<env>` 块**不能整块删**（429），至少要保留
  `Working directory`；`Platform`、`Is directory a git repo`、`Workspace root folder`
  都可以删（均已实测）。
- **工作目录写 `./`**：绝对路径会让模型以为自己能访问那个目录。由 `shape.go` 的
  `workdir` 常量填充。
- **`tools` 必须是官方工具集整套**：`internal/shape/assets/tools.json` 里的 12 个（`edit`、
  `glob`、`grep`、`question`、`read`、`shell`、`skill`、`subagent`、`webfetch`、`websearch`、
  `write`、`execute`）缺一不可。去掉、置空或只挑几个（旧实现只发 `read`）都会被上游拒；
  唯一的改动是每个工具的描述统一换成禁止调用（见下节）。
- `stream: true` + `stream_options.include_usage`；`stream:false` 也 429，非流式在本地聚合。
- `max_completion_tokens: 32000`。
- `ses_` 会话 id：12 位倒序十六进制时间戳 + 14 位 base62。时间戳取当前毫秒，
  **毫秒内序号从 1 开始**（序号 0 会落到 0xFFF 被拒）。

提示词占位符只有四个：`{{MODEL}}`、`{{MODELNAME}}`、`{{DATE}}`、`{{WORKDIR}}`。

请求头里 `x-opencode-project` 用固定哈希即可；UA 固定 `opencode/latest/2.1.1/cli`（对齐 v2 通道的
官方客户端）。`b3` / `traceparent` 官方客户端不发，实现里已经删掉，别再加回来。

## 工具整形

1. 客户端声明的工具改名 `oc2api_<sanitized>`（`internal/shape` 的 `ToolPrefix`），
   响应侧按同一前缀还原；
2. 官方工具**整套发送**（12 个，见上节），但每个的描述都换成 "Reserved for the host runtime;
   do not call or select this function. Use tools explicitly supplied by the user instead."，
   客户端执行不了它们，真被选中也只能在响应侧丢掉；
3. 客户端没声明任何工具时，system 末尾补一句“不要调用工具”；
4. 兜底：`internal/protocol` 按 `index` 缓冲工具调用，确认不是 `oc2api_` 的整条丢弃，
   `finish_reason` 从 `tool_calls` 回退 `stop`；非流式没有正文时带更强提示重试一次。

## Vercel 为什么是「薄 Node + Go 二进制」

Vercel 的 Go runtime 会**缓冲整段响应**：用 700ms 间隔 flush 的测试函数，客户端 5 帧在
同一秒到达（服务端时间戳跨了 3 秒）。SSE 出不来，所以：

- `scripts/build-go.sh` 构建期下载 Go 工具链、交叉编译 `linux/amd64` 到 `bin/`，并加
  `-tags nomihomo`（不打包 mihomo 内核，二进制约 8MB）；
- `api/index.js` 首个请求把二进制拷到 `/tmp`、`chmod +x`、`spawn -stdio` 后常驻；
- 每条请求带自增 `id`，Go 侧按 id 回通知，Node 用 `Map<id, handler>` 分发，并发流不串；
- `vercel.json` 用 `includeFiles: bin/**` 把二进制打进函数。

注意：根目录没有 `package.json`，一旦配了 `buildCommand`，Vercel 就用 `@vercel/static-build`
处理根目录，它的 `validateDistDir` 要求输出目录（`outputDirectory`，缺省是 `dist`）**存在且
非空**，否则报 `STATIC_BUILD_NO_OUT_DIR` / `STATIC_BUILD_EMPTY_OUT_DIR`。所以构建脚本要生成
`public/robots.txt` 占位；**不能放 index.html**——静态文件优先于 `rewrites`（部署实例的
`/robots.txt` 返回的是静态 etag），放了 `index.html` 就会抢走 `/`，拿不到和 `/health` 同构的
JSON。仓库里没有 `public/`，`.gitignore` 和 `.vercelignore` 都排除它。

## 测试

```bash
go test ./...                   # 单元测试（整形、响应过滤、错误语义、节点池/策略）
go test -tags nomihomo ./...    # 无内核构建也必须能编译并过测
go vet ./...
golangci-lint run ./...         # 配置见 .golangci.yml
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/oc2api
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nomihomo ./cmd/oc2api
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
- **Vercel 无内核**：`-tags nomihomo` 构建只能解析纯文本/URI 的 http/socks5，Clash 多协议订阅
  用不了，`/health` 也不返回节点列表；需要全协议请用 Docker / 本地版本。
- **节点健康状态只在内存**：进程重启会重新探测，不做持久化。
- **测试覆盖**：`internal/httpapi`、`internal/rpc` 和 `api/index.js` 还没有测试。
