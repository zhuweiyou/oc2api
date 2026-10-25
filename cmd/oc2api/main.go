// oc2api 的 Go 核心：本地/Docker 直接起 HTTP 服务，Vercel 用 -rpc 走 JSON-RPC。
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"oc2api/internal/httpapi"
	"oc2api/internal/rpc"
)

func main() {
	rpcMode := flag.Bool("rpc", false, "以 HTTP JSON-RPC 模式启动（调试用）")
	stdio := flag.Bool("stdio", false, "以 stdio JSON-RPC 模式启动（Vercel 上由 Node 薄层拉起）")
	listen := flag.String("listen", "", "监听地址，默认取 PORT（:8080）")
	flag.Parse()

	addr := *listen
	if addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		addr = ":" + port
	}

	if *stdio {
		log.Printf("oc2api go (stdio rpc) ready")
		if err := rpc.ServeStdio(); err != nil {
			log.Fatal(err)
		}
		return
	}

	var h http.Handler
	mode := "http"
	if *rpcMode {
		h = rpc.Handler()
		mode = "rpc"
	} else {
		h = httpapi.Server()
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("oc2api go (%s) listening on %s", mode, addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
