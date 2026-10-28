# 纯 Go 运行时：编译成静态二进制，镜像里只有这个二进制和 CA 证书。
FROM golang:1.24-alpine AS build
ARG GO_TAGS=""
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -tags "$GO_TAGS" -trimpath -buildvcs=false -ldflags "-s -w" -o /out/oc2api ./cmd/oc2api

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/oc2api /oc2api
ENV PORT=8080
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/oc2api"]
