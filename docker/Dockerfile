# 纯 Go 运行时：编译成静态二进制，镜像里没有 Node、没有依赖树。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" -o /out/oc2api ./cmd/oc2api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/oc2api /usr/local/bin/oc2api
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/oc2api"]
