#!/usr/bin/env bash
# Vercel 构建阶段：把 Go 核心编译成 linux 二进制，随 Node 函数一起打包。
# 运行时由 api/index.js 首次请求时 spawn（-stdio），流式响应才走得通。
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.24.13}"

if ! command -v go >/dev/null 2>&1; then
  echo "go not found, downloading ${GO_VERSION}"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  tar -C /tmp -xzf /tmp/go.tar.gz
  export PATH="/tmp/go/bin:$PATH"
fi

mkdir -p bin public
# Vercel 只要配了 buildCommand 就要求静态输出目录非空。这里生成一个 robots.txt，
# 不放 index.html——否则 / 会被静态文件抢走，拿不到 /health 同构的 JSON。
printf 'User-agent: *\nDisallow:\n' > public/robots.txt
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/oc2api ./cmd/oc2api
chmod +x bin/oc2api
ls -la bin
