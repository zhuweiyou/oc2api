// oc2api 的 Go 核心：默认起 HTTP 服务；-stdio 走 JSON-RPC（Vercel 由薄 Node 层拉起）。
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

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.Server(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("oc2api go (http) listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
