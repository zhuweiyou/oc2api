# app.js 拆分重构 TODO

分支：`feature/split-refactor`

## 决策（已确认）

- [x] 扁平拆分，按功能域内聚，不建多层目录
- [x] `config.js` 只放程序版本 + API_KEY 鉴权约定；URL/超时/头常量跟随各自文件
- [x] 不建 utils.js；方法放使用它的文件里
- [x] 被 ≥2 个功能文件共用的函数放 `shared.js`
- [x] CORS 用 npm `cors` 库（已装 v2.8.6），配置成现行为：origin `*`、
      methods 串 `"GET, POST, OPTIONS"`（测试断言含空格，不能传数组）、
      allowedHeaders 现有列表、exposedHeaders `X-Request-Id`、OPTIONS→204
- [x] **不经过 app 导出 `__test`**：测试直接 import 目标方法（`server/zen.js`、
      `server/openai.js`），删除 `__test` 与 `handler` 导出
- [x] 鉴权改路由级：`requireAuth` 只挂 models/chat；未知路径直接 404（有意变更，新测试固化）

## 结构

```
server/
├── app.js       # 组装 + 路由声明，default export（~40 行）
├── index.js     # 不变
├── config.js    # PROXY_VERSION + readApiKey
├── shared.js    # sendJson/openAIErrorResponse/upstreamErrorResponse/safeJsonParse/ocId
├── middleware.js# cors/normalizeUrl/rawBody/requireAuth/notFound/errorHandler
├── handler.js   # health/ip/models/chat 端点编排
├── zen.js       # 上游客户端：URL/超时/UA/buildZenRequest/fetchZen/models/session
├── openai.js    # 响应转换：非流式聚合/SSE 转发/normalizer/think 剥离
└── log.js       # debugLog/logZen*/logUpstreamBody
```

## 步骤

- [x] 1. 写 config/shared/log/zen/openai/handler 纯搬移
- [x] 2. 写 middleware.js（cors + rawBody + requireAuth + 兜底）
- [x] 3. 重写 app.js 为 Router 声明，删 Fetch 适配器
- [x] 4. handler/openai 直写 res（SSE res.write 管道 + drain）
- [x] 5. 测试改直接 import；追加新行为测试（404/尾斜杠/公开路由）
- [x] 6. 更新 README 架构小节
- [x] 7. lint + format:check + test 全绿

## 验收

- 16 离线测试通过（+ 新增 3 个）
- 三入口同一 app；`/health`、`/v1/models`、chat 行为不变
- 未知路径 → 404（带不带错 key 都是）；受保护路径错 key → 401
