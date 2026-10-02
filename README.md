# oc2api

> ⚠️ **2026-08-21 提醒**：`deepseek-v4-flash-free` 模型已官方下线，不再提供免费额度。如需使用请更换其他模型，建议用 `big-pickle` 和 `mimo-v2.6-flash-free`，其中 `mimo-v2.6-flash-free` 支持图片输入。

OpenCode Free API 代理，使用一套 Express 业务逻辑，同时支持本地运行、Docker 和 Vercel 部署，并支持 SSE 流式响应。

```mermaid
flowchart TD
    client["客户端<br/>Claude Code / Codex / DSH 等"]
    gateway["聚合网关<br/>CLIProxyAPI / SUB2API / NEWAPI"]
    a["oc2api 实例 A<br/>出口 IP 1"]
    b["oc2api 实例 B<br/>出口 IP 2"]
    c["oc2api 实例 C<br/>出口 IP 3"]
    zen["OpenCode Zen<br/>免费模型"]

    client --> gateway
    gateway -->|轮询 / 负载| a
    gateway -->|轮询 / 负载| b
    gateway -->|轮询 / 负载| c
    a --> zen
    b --> zen
    c --> zen
```

## Vercel 部署

### 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api&env=API_KEY%2CDEBUG&envDefaults=%7B%22API_KEY%22%3A%22sk-zhu%22%2C%22DEBUG%22%3A%22true%22%7D&envDescription=API_KEY%EF%BC%9AAPI%20%E5%AF%86%E9%92%A5%EF%BC%88%E7%95%99%E7%A9%BA%E5%88%99%E5%8C%BF%E5%90%8D%E8%AE%BF%E9%97%AE%EF%BC%89%EF%BC%9BDEBUG%EF%BC%9A%E8%AE%BE%E4%B8%BA%20true%20%E5%BC%80%E5%90%AF%E8%B0%83%E8%AF%95%E6%97%A5%E5%BF%97&envLink=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api%23vercel-%E9%83%A8%E7%BD%B2)

### 手动部署

1. Fork 本仓库到你的 GitHub
2. 打开 [Vercel Dashboard](https://vercel.com)，点击 **Add New > Project**
3. 选择你 Fork 的仓库，点击 **Import**
4. 在 **Environment Variables** 中添加：
   - `API_KEY` — API 密钥（留空则匿名访问）
   - `DEBUG` — 设为 `true` 开启调试日志（可选）
5. 点击 **Deploy**，等待部署完成

部署完成后会得到一个 `https://<项目名>.vercel.app` 的域名。

你可以 Fork 后部署多个 Vercel Project，以创建多个出口 IP 不同的项目，然后在 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api) 等聚合网关中配置多个域名实现轮询，既规避 IP 限制，也把并发分摊到多个实例：

## 本地运行

要求 Node.js 24 或更高版本。

```bash
npm install
npm start
```

默认监听 `http://localhost:8080`。也可以通过环境变量配置：

```bash
API_KEY=your-key DEBUG=true PORT=8080 npm start
```

健康检查：

```bash
curl http://localhost:8080/health
```

## Docker 部署

Docker 配置位于项目根目录：

```bash
docker compose up -d --build
```

## 测试

离线测试不访问 OpenCode：

```bash
npm test
```

真实联调测试会向 `big-pickle` 发送两次请求：一次不带 tools 的非流式 `hi`，以及一次带 tools 的流式连续对话，并分别验证本地与 Vercel 入口（共 4 次请求）：

```bash
npm run test:live
```

真实测试可能受到上游限流影响；限流时测试会输出原因并跳过，不影响离线测试。

## 代码检查

```bash
npm run lint          # ESLint 静态检查
npm run format:check  # 检查格式是否规范
npm run format        # 用 Prettier 自动格式化全部文件
```

GitHub Actions 与 Docker 构建都会先执行 lint 和格式检查，不通过则构建失败。

## API

兼容 OpenAI API 格式，路径均支持带 `/v1` 前缀或不带：

| 路径                                          | 方法 | 说明                                  |
| --------------------------------------------- | ---- | ------------------------------------- |
| `/v1/chat/completions` 或 `/chat/completions` | POST | Chat 补全（支持 `stream: true` 流式） |
| `/v1/models` 或 `/models`                     | GET  | 模型列表                              |
| `/` 或 `/health`                              | GET  | 健康检查                              |
| `/ip`                                         | GET  | 查询出口 IP                           |

配置 API Key 后，请求携带：

```text
Authorization: Bearer <api-key>
```

也支持 `X-API-Key`。

## 免费模型限制

代理仅放行免费模型（`big-pickle` 及所有以 `-free` 结尾的模型），以 `big-pickle` 为例：

```json
{
  "id": "big-pickle",
  "limit": {
    "context": 200000,
    "output": 32000
  }
}
```

- `context`：最大上下文窗口，**200,000** tokens
- `output`：最大单次输出长度，**32,000** tokens

以上限制数据来源于接口 [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json)（`opencode` key 下对应模型的 `limit` 字段），可自行查看核实，以实际使用为准。

上游失败（限流、鉴权、超时等）统一以 `429` 返回，便于 CLIProxyAPI / sub2api / new-api 等账号池工具切换账号。
