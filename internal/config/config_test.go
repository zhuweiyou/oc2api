package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("API_KEY", "")
	t.Setenv("DEBUG", "")
	t.Setenv("PORT", "")
	t.Setenv("ZEN_API_BASE_URL", "")
	t.Setenv("ZEN_CONNECT_TIMEOUT_MS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("默认配置不该报错: %v", err)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, 期望 8080", cfg.Port)
	}
	if cfg.ZenAPIBaseURL != DefaultZenAPIBaseURL {
		t.Errorf("ZenAPIBaseURL = %q, 期望 %q", cfg.ZenAPIBaseURL, DefaultZenAPIBaseURL)
	}
	if cfg.ZenConnectTimeout != 60*time.Second {
		t.Errorf("ZenConnectTimeout = %v, 期望 60s", cfg.ZenConnectTimeout)
	}
	if cfg.Debug {
		t.Error("Debug 默认应为 false")
	}
}

func TestLoadFromEnv(t *testing.T) {
	t.Setenv("API_KEY", "  sk-test  ")
	t.Setenv("DEBUG", "true")
	t.Setenv("PORT", "9090")
	t.Setenv("ZEN_API_BASE_URL", "http://127.0.0.1:2082/")
	t.Setenv("ZEN_CONNECT_TIMEOUT_MS", "300000")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("合法配置不该报错: %v", err)
	}
	if cfg.APIKey != "sk-test" {
		t.Errorf("APIKey = %q, 期望去掉首尾空白", cfg.APIKey)
	}
	if !cfg.Debug {
		t.Error("DEBUG=true 时 Debug 应为 true")
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q, 期望 9090", cfg.Port)
	}
	if cfg.ZenAPIBaseURL != "http://127.0.0.1:2082" {
		t.Errorf("ZenAPIBaseURL = %q, 结尾斜杠应被去掉", cfg.ZenAPIBaseURL)
	}
	if cfg.ZenConnectTimeout != 300*time.Second {
		t.Errorf("ZenConnectTimeout = %v, 期望 300s", cfg.ZenConnectTimeout)
	}
}

// 只写 "true" 才算开启，和 Node 版保持一致的显式比较。
func TestLoadDebugNeedsLiteralTrue(t *testing.T) {
	t.Setenv("DEBUG", "false")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if cfg.Debug {
		t.Error("DEBUG=false 时 Debug 应为 false")
	}
}

func TestLoadPortFallsBack(t *testing.T) {
	for _, raw := range []string{"", "abc", "0", "65536"} {
		t.Setenv("PORT", raw)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("PORT=%q 不该报错: %v", raw, err)
		}
		if cfg.Port != "8080" {
			t.Errorf("PORT=%q 时 Port = %q, 期望回落 8080", raw, cfg.Port)
		}
	}
}

func TestLoadRejectsBadZenBaseURL(t *testing.T) {
	for _, raw := range []string{"opencode.ai", "ftp://opencode.ai", "https://"} {
		t.Setenv("ZEN_API_BASE_URL", raw)
		if _, err := Load(); err == nil {
			t.Errorf("ZEN_API_BASE_URL=%q 应该报错", raw)
		}
	}
}

func TestLoadRejectsBadConnectTimeout(t *testing.T) {
	for _, raw := range []string{"abc", "0", "-1", "600001", "1.5"} {
		t.Setenv("ZEN_CONNECT_TIMEOUT_MS", raw)
		if _, err := Load(); err == nil {
			t.Errorf("ZEN_CONNECT_TIMEOUT_MS=%q 应该报错", raw)
		}
	}
}
