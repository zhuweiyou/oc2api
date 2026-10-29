#!/usr/bin/env bash
# Vercel 构建阶段：把 Go 核心编译成 linux 二进制，随 Node 函数一起打包。
# 运行时由 api/index.js 首次请求时 spawn（-stdio），流式响应才走得通。
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.24.13}"
# 版本号构建期注入：优先用显式 VERSION；否则生成 goreleaser 风格快照号
# <最近tag>-SNAPSHOT-<短sha>（如 4.4.0-SNAPSHOT-8d598e3）；取不到 git 时退回 0.0.0。
VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  short="$(git rev-parse --short HEAD 2>/dev/null || true)"
  base="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
  base="${base#v}"
  if [ -n "$short" ]; then
    VERSION="${base:-0.0.0}-SNAPSHOT-${short}"
  else
    VERSION="0.0.0"
  fi
fi

if ! command -v go >/dev/null 2>&1; then
  echo "go not found, downloading ${GO_VERSION}"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  tar -C /tmp -xzf /tmp/go.tar.gz
  export PATH="/tmp/go/bin:$PATH"
fi

mkdir -p bin public
# 根目录没有 package.json 但有 buildCommand，Vercel 会用 @vercel/static-build 处理根目录，
# 它的 validateDistDir 要求 outputDirectory（这里 public）存在且非空，否则构建直接失败。
# 只用 robots.txt 占位，不放 index.html——静态文件优先于 rewrites，会抢走 /。
printf 'User-agent: *\nDisallow:\n' > public/robots.txt
# Vercel 走无内核构建：-tags nomihomo 排除 mihomo，二进制约 8MB。
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nomihomo -trimpath -buildvcs=false \
  -ldflags "-s -w -X oc2api/internal/config.Version=${VERSION}" -o bin/oc2api ./cmd/oc2api
chmod +x bin/oc2api
ls -la bin
