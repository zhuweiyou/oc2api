// 程序版本与鉴权配置。
// URL、超时、协议头等常量留在各自功能文件（zen/openai/middleware）里保持内聚。

export const PROXY_VERSION = "v2.2.0"

// API_KEY 约定：留空则匿名访问。
export function readApiKey() {
  return process.env.API_KEY
}
