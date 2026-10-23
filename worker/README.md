# Cloudflare Workers 部署

把 oc2api 跑在 Cloudflare 边缘。业务逻辑全部复用仓库根目录的 `server/`，本目录只有 Workers 原生入口与 Web Streams 适配：

| 文件             | 作用                                                     |
| ---------------- | -------------------------------------------------------- |
| `src/index.js`   | 路由、鉴权、请求体解析、`/health`、`/ip`、`/v1/models`   |
| `src/respond.js` | 把 `server/openai.js` 产出的 SSE 帧写进 `ReadableStream` |
| `wrangler.jsonc` | Worker 名称、入口、`nodejs_compat`                       |

因此**改上游行为只需要改 `server/`**，Node 版与 Workers 版会一起生效。

## 为什么优先推荐 Workers

免费模型的额度按出口 IP 计量。Vercel 的 AWS 出口段实测长期处于限流状态（对话返回 `429 rate_limit_error`，同时 `/v1/models` 正常），而 Cloudflare 边缘出口目前可用。两家都不保证额度，只是 CF 现在更容易跑通。

## 前置条件

- Cloudflare 账号（免费计划足够）
- Node.js 20+ 与 `wrangler`

```bash
npm i -g wrangler@latest
wrangler login
```

## 部署

在**仓库根目录**执行（`wrangler deploy` 必须在 `worker/` 目录里跑，因为构建期要读取 `../server`）：

```bash
cd worker
wrangler deploy
```

首次部署会创建 `https://oc2api.<你的子域>.workers.dev`。想换名字就改 `wrangler.jsonc` 里的 `name`。

## 配置密钥

```bash
# 可选：不设置则匿名访问
wrangler secret put API_KEY

# 可选：调试日志
wrangler secret put DEBUG        # 值填 true 才开启
```

`API_KEY`、`DEBUG`、`ZEN_API_BASE_URL`、`ZEN_CONNECT_TIMEOUT_MS` 与 Node 版同名同义。Worker 侧通过 `nodejs_compat` 把 vars/secret 映射进 `process.env`，所以 `server/` 里的读取逻辑不用改；部署后用 `/health` 的 `upstream`、`debug` 字段可以确认实际生效值。

## 本地调试

```bash
cd worker
wrangler dev          # 本地模拟运行时，出站请求从本机发出
wrangler dev --remote # 跑在真实边缘，出站请求从 Cloudflare 网络发出
```

## 校验

```bash
curl https://oc2api.<你的子域>.workers.dev/health
curl https://oc2api.<你的子域>.workers.dev/ip
curl https://oc2api.<你的子域>.workers.dev/v1/models -H "Authorization: Bearer $API_KEY"

curl -N https://oc2api.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 限制

- 限制的是 **CPU 时间**，不是请求总耗时：免费计划 10ms/请求，付费计划默认 30s（可配到 5 分钟）。等待上游返回不计入 CPU，但请求体的 `JSON.stringify`、每个 SSE 帧的 `JSON.parse`/`JSON.stringify` 都计入，几十万 token 的长上下文可能吃紧。超限时 Cloudflare 返回 `1102 Worker exceeded resource limits`，表现为 5xx，和上游的 429 不是一回事。
- 请求体上限按 Workers 规则（免费 100MB）。
- 未配置 `ZEN_API_BASE_URL` 时直连 `https://opencode.ai/inference/v1`；Workers 里不要指向 `localhost` 之类的中继地址。
