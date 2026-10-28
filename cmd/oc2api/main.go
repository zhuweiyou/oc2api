// oc2api 的 Go 核心：默认起 HTTP 服务；-stdio 走 JSON-RPC（Vercel 由薄 Node 层拉起）。
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"time"

	"oc2api/internal/chat"
	"oc2api/internal/config"
	"oc2api/internal/httpapi"
	"oc2api/internal/proxypool"
	"oc2api/internal/rpc"
	"oc2api/internal/zen"
)

func main() {
	stdio := flag.Bool("stdio", false, "以 stdio JSON-RPC 模式启动（Vercel 上由 Node 薄层拉起）")
	listen := flag.String("listen", "", "监听地址，默认取 PORT（:8080）")
	flag.Parse()

	// 配置只在启动阶段读一次，之后全部靠注入传下去。
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}

	client := zen.New(cfg)
	// 配置了订阅地址：启动阶段就加载订阅并开始健康探测，不等第一次请求。
	var proxies *proxypool.Pool
	if cfg.ProxySubscriptionURL != "" {
		proxies = proxypool.New(cfg.ProxySubscriptionURL, cfg.ProxyHealthInterval, cfg.ProxyRefreshInterval, proxypool.Strategy(cfg.ProxyStrategy))
		if err := proxies.Start(context.Background()); err != nil {
			log.Printf("代理池加载失败: %v（服务继续启动，后续请求会重试）", err)
		} else {
			log.Printf("代理池已加载: %d 个节点，健康探测进行中", proxies.Size())
		}
	}
	chats := chat.New(cfg, client, proxies)

	proxyState := "off"
	if proxies != nil {
		proxyState = "on"
	}

	if *stdio {
		log.Printf("oc2api go (stdio rpc) v%s upstream=%s timeout=%s proxy=%s", config.Version, cfg.ZenAPIBaseURL, cfg.ZenConnectTimeout, proxyState)
		if err := rpc.New(cfg, client, chats).ServeStdio(); err != nil {
			log.Fatal(err)
		}
		return
	}

	addr := *listen
	if addr == "" {
		addr = ":" + cfg.Port
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(cfg, client, chats, proxies),
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("oc2api go (http) v%s listening on %s upstream=%s timeout=%s proxy=%s", config.Version, addr, cfg.ZenAPIBaseURL, cfg.ZenConnectTimeout, proxyState)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
