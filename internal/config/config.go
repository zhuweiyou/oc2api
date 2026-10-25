// Package config 收拢进程级配置与版本号，全部来自环境变量，和 Node 版同名。
package config

import (
	"os"
	"strings"
)

// Version 与 package.json 的版本保持一致，/health 直接透出。
const Version = "3.0.0"

type Config struct {
	APIKey string
	Debug  bool
}

func Load() Config {
	return Config{
		APIKey: strings.TrimSpace(os.Getenv("API_KEY")),
		Debug:  os.Getenv("DEBUG") == "true",
	}
}
