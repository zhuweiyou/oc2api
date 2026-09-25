// 顶层可变配置：进程启动时从环境变量初始化，
// 运行期可直接改属性覆盖（测试用 config.apiKey = "sk-test" 切换鉴权场景）。
// 注意 ESM 导出的 const 绑定对外只读，但对象属性是可变的。
//
// URL、超时、协议头等常量留在各自功能文件（zen/openai/middleware）里保持内聚。

import pkg from "../package.json" with { type: "json" }

export const config = {
  // 程序版本：取自 package.json，发版只需改 package.json（npm version）一处
  version: pkg.version,
  // 鉴权密钥：留空则匿名访问
  apiKey: process.env.API_KEY,
  // 调试开关：只有字符串 "true" 才开启（"false" 也是真值，必须显式比较）
  debug: process.env.DEBUG === "true",
  // 监听端口：PORT 未设置或不是合法数字时用 8080
  port: Number(process.env.PORT) || 8080,
}
