package zen

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"

	"oc2api/internal/config"
)

const (
	clientUA  = "opencode/latest/2.1.1/cli"
	projectID = "3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787"

	// 上游接口路径集中在这两行：ZEN_API_BASE_URL 只给站点根，
	// 上游换路径（/zen/v1 → /inference/v1 这类）时只改这里，部署配置不用动。
	chatPath   = "/inference/v1/chat/completions"
	modelsPath = "/inference/v1/models"
)

// Bun 的 ClientHello：免费层按传输层指纹识别客户端，Go 自带的 crypto/tls
// 握手会被判成非 OpenCode 流量并回 429，所以这里用 uTLS 复刻 Bun 的握手。
func bunClientHello() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			utls.TLS_AES_128_GCM_SHA256, utls.TLS_AES_256_GCM_SHA384, utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256, utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA, utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []uint8{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384}},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.StatusRequestExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256, utls.PSSWithSHA256, utls.PKCS1WithSHA256,
				utls.ECDSAWithP384AndSHA384, utls.PSSWithSHA384, utls.PKCS1WithSHA384,
				utls.PSSWithSHA512, utls.PKCS1WithSHA512, utls.PKCS1WithSHA1,
			}},
			&utls.SCTExtension{},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}
}

// Client 是带上游地址与超时的客户端，连接复用、握手按连接做一次。
type Client struct {
	http      *http.Client
	chatURL   string
	modelsURL string
}

// New 按注入的配置组装上游客户端。
func New(cfg config.Config) *Client {
	return &Client{
		http:      &http.Client{Transport: newTransport(cfg.ZenConnectTimeout), Timeout: 0},
		chatURL:   cfg.ZenAPIBaseURL + chatPath,
		modelsURL: cfg.ZenAPIBaseURL + modelsPath,
	}
}

// newTransport 用同一个超时兜住建连、TLS 握手与等响应头；正文流式读取不设上限，
// 否则长回答会被截断。
func newTransport(connectTimeout time.Duration) *http.Transport {
	// 自建中继可能是 http://（不经过 DialTLSContext），所以普通拨号也要挂同一个超时。
	dialer := &net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second}
	return &http.Transport{
		ForceAttemptHTTP2:     false,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: connectTimeout,
		DialContext:           dialer.DialContext,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				host = addr
			}
			conn, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			// 自定义 DialTLSContext 时 http.Transport 不再代管握手（TLSHandshakeTimeout 不生效），
			// 这里自己给握手加 deadline，避免上游卡在握手上把请求挂死。
			handshakeCtx, cancel := context.WithTimeout(ctx, connectTimeout)
			defer cancel()
			tlsConn := utls.UClient(conn, &utls.Config{ServerName: host, MinVersion: tls.VersionTLS12}, utls.HelloCustom)
			if err := tlsConn.ApplyPreset(bunClientHello()); err != nil {
				_ = conn.Close()
				return nil, err
			}
			if err := tlsConn.HandshakeContext(handshakeCtx); err != nil {
				_ = conn.Close()
				return nil, err
			}
			return tlsConn, nil
		},
	}
}

// Chat 发起一次上游对话请求；上游只接受流式，非流式由调用方聚合。
func (c *Client) Chat(ctx context.Context, body []byte, session string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range UpstreamHeaders(session) {
		req.Header.Set(key, value)
	}
	return c.http.Do(req)
}

// Models 拉取上游模型列表并只保留免费模型。
func (c *Client) Models(ctx context.Context) ([]map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.modelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", clientUA)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("上游模型列表返回 %d: %s", res.StatusCode, strings.TrimSpace(string(text)))
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, err
	}
	models := make([]map[string]any, 0, len(payload.Data))
	for _, model := range payload.Data {
		id, _ := model["id"].(string)
		if id == "big-pickle" || strings.HasSuffix(id, "-free") {
			models = append(models, map[string]any{
				"id":       id,
				"object":   "model",
				"created":  model["created"],
				"owned_by": "opencode",
			})
		}
	}
	return models, nil
}

// SessionID 生成官方客户端同款的 ses_ id：12 位倒序时间戳 + 14 位 base62。
const idChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var (
	sessionMu    sync.Mutex
	sessionLast  int64
	sessionCount uint64
)

func SessionID() string {
	sessionMu.Lock()
	now := time.Now().UnixMilli()
	if now != sessionLast {
		sessionLast = now
		sessionCount = 0
	}
	// 上游只接受 1..15 的毫秒内序号：序号 0 会把低 12 位填成 0xFFF，实测被判 429。
	counter := sessionCount%15 + 1
	sessionCount++
	sessionMu.Unlock()

	value := ^(uint64(now)*0x1000 + counter)
	var b strings.Builder
	b.WriteString("ses_")
	for i := 0; i < 6; i++ {
		fmt.Fprintf(&b, "%02x", byte(value>>(40-8*i)))
	}
	random := make([]byte, 14)
	_, _ = rand.Read(random)
	for _, r := range random {
		b.WriteByte(idChars[int(r)%62])
	}
	return b.String()
}

// UpstreamHeaders 复刻官方客户端的请求头。
func UpstreamHeaders(session string) map[string]string {
	// 只做免费层：固定使用公共匿名标识。
	const token = "public"
	return map[string]string{
		"Content-Type":          "application/json",
		"Authorization":         "Bearer " + token,
		"User-Agent":            clientUA,
		"Accept":                "*/*",
		"x-opencode-client":     "cli",
		"x-opencode-project":    projectID,
		"x-opencode-session":    session,
		"x-opencode-session-id": session,
		"x-session-affinity":    session,
		"X-Session-Id":          session,
	}
}
