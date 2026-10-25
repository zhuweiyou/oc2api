// Package config 收拢进程级配置与版本号，全部来自环境变量，和 Node 版同名。
package config

import (
	"os"
	"strings"
	"sync"
)

// Version 与 package.json 的版本保持一致，/health 直接透出。
const Version = "4.0.0"

type Config struct {
	APIKey string
	Debug  bool
}

// 环境变量在进程生命周期内不会变，读一次就够了。
var current = sync.OnceValue(func() Config {
	return Config{
		APIKey: strings.TrimSpace(os.Getenv("API_KEY")),
		Debug:  os.Getenv("DEBUG") == "true",
	}
})

// Get 返回进程级配置；首次调用时读取环境变量，之后直接返回缓存值。
func Get() Config {
	return current()
}
