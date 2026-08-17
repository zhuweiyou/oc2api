# oc2api

OpenCode API 代理，部署在 Vercel，支持 SSE 流式响应。

如需本地部署或部署到其他云平台，参见 [server/](./server/) 目录。

## 部署

### 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api&env=API_KEY%2CDEBUG&envDefaults=%7B%22API_KEY%22%3A%22sk-zhu%22%2C%22DEBUG%22%3A%22true%22%7D&envDescription=API_KEY%EF%BC%9AAPI%20%E5%AF%86%E9%92%A5%EF%BC%88%E7%95%99%E7%A9%BA%E5%88%99%E5%8C%BF%E5%90%8D%E8%AE%BF%E9%97%AE%EF%BC%89%EF%BC%9BDEBUG%EF%BC%9A%E8%AE%BE%E4%B8%BA%20true%20%E5%BC%80%E5%90%AF%E8%B0%83%E8%AF%95%E6%97%A5%E5%BF%97&envLink=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api%23%E9%83%A8%E7%BD%B2)

### 手动部署

1. Fork 本仓库到你的 GitHub
2. 打开 [Vercel Dashboard](https://vercel.com)，点击 **Add New > Project**
3. 选择你 Fork 的仓库，点击 **Import**
4. 在 **Environment Variables** 中添加：
    - `API_KEY` — API 密钥（留空则匿名访问）
    - `DEBUG` — 设为 `true` 开启调试日志（可选）
5. 点击 **Deploy**，等待部署完成

部署完成后会得到一个 `https://<项目名>.vercel.app` 的域名。

你可以 Fork 后部署多个 Vercel Project，以创建多个出口 IP 不同的项目，然后在 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/blob/main/README_CN.md#%E5%8A%9F%E8%83%BD%E7%89%B9%E6%80%A7)、[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api/blob/main/README_CN.md#%E9%83%A8%E7%BD%B2%E6%96%B9%E5%BC%8F)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api/blob/main/README.zh_CN.md#-%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B) 等工具中配置多个域名实现轮询，规避 IP 限制。

## API

兼容 OpenAI API 格式，路径均支持带 `/v1` 前缀或不带：

| 路径                                           | 方法   | 说明                            |
|----------------------------------------------|------|-------------------------------|
| `/v1/chat/completions` 或 `/chat/completions` | POST | Chat 补全（支持 `stream: true` 流式） |
| `/v1/models` 或 `/models`                     | GET  | 模型列表                          |
| `/` 或 `/health`                             | GET  | 健康检查                          |
| `/ip`                                        | GET  | 查询出口 IP                       |

携带 API Key（如已配置）：

```
Authorization: Bearer <api-key>
```

## 免费模型限制

代理仅放行免费模型（`big-pickle` 及所有以 `-free` 结尾的模型），以 `deepseek-v4-flash-free` 为例：

```json
{
  "id": "deepseek-v4-flash-free",
  "limit": {
    "context": 200000,
    "output": 128000
  }
}
```

- `context`：最大上下文窗口，**200,000** tokens
- `output`：最大单次输出长度，**128,000** tokens

以上限制数据来源于接口 [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json)（`opencode` key 下对应模型的 `limit` 字段），可自行查看核实，以实际使用为准。

## 推理强度（reasoning_effort）

目前 `reasoning_effort` 仅对 DeepSeek 模型生效：DeepSeek 只接受 `high` / `max`，两者原样透传，其余值（包括未指定）会被强制为 `high`；其他模型不处理该参数，保持默认值。

## 图片请求

DeepSeek 仅支持文本输入。当**最近一条 `user` 消息**包含图片（`type` 为 `image_url` 或 `image` 的 content part）时，代理会把该请求路由到带图模型 `mimo-v2.5-free` 处理，并在响应中把 `model` 字段改写为您请求的 DeepSeek 模型，对客户端透明。

- 路由只由**最近一条 user 消息**决定：历史中残留的图片不会再次触发回退。
- 因此「发图提问 → 拿到结果后纯文字追问」的下一轮会**自动回到 DeepSeek**，不会一直走 `mimo-v2.5-free`。
