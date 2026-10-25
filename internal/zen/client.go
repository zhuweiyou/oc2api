package zen

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

const (
	UpstreamBase = "https://opencode.ai/inference"
	clientUA     = "opencode/latest/2.1.4/cli"
	projectID    = "3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787"
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

var (
	clientOnce sync.Once
	client     *http.Client
)

// Client 返回带 Bun 指纹的 HTTP 客户端（连接复用，握手按连接做一次）。
func Client() *http.Client {
	clientOnce.Do(func() {
		transport := &http.Transport{
			ForceAttemptHTTP2:     false,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 90 * time.Second,
			DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(addr)
				if err != nil {
					host = addr
				}
				dialer := &net.Dialer{Timeout: 10 * time.Second}
				conn, err := dialer.DialContext(ctx, "tcp", addr)
				if err != nil {
					return nil, err
				}
				tlsConn := utls.UClient(conn, &utls.Config{ServerName: host}, utls.HelloCustom)
				if err := tlsConn.ApplyPreset(bunClientHello()); err != nil {
					_ = conn.Close()
					return nil, err
				}
				if err := tlsConn.HandshakeContext(ctx); err != nil {
					_ = conn.Close()
					return nil, err
				}
				return tlsConn, nil
			},
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		client = &http.Client{Transport: transport, Timeout: 0}
	})
	return client
}

// Base 返回上游地址，允许 ZEN_API_BASE_URL 覆盖（默认免费层 inference 入口）。
func Base() string {
	if value := strings.TrimSpace(os.Getenv("ZEN_API_BASE_URL")); value != "" {
		return strings.TrimRight(value, "/")
	}
	return UpstreamBase
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
	trace, span := randomHex(16), randomHex(8)
	return map[string]string{
		"Content-Type":          "application/json",
		"Authorization":         "Bearer " + token,
		"User-Agent":            clientUA,
		"Accept":                "*/*",
		"b3":                    trace + "-" + span + "-1-" + randomHex(8),
		"traceparent":           "00-" + trace + "-" + span + "-01",
		"x-opencode-client":     "cli",
		"x-opencode-project":    projectID,
		"x-opencode-session":    session,
		"x-opencode-session-id": session,
		"x-session-affinity":    session,
		"X-Session-Id":          session,
	}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// Post 用 Bun 指纹把请求发到上游。
func Post(ctx context.Context, path string, body []byte, session string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Base()+path, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	for key, value := range UpstreamHeaders(session) {
		req.Header.Set(key, value)
	}
	return Client().Do(req)
}

// FetchModels 拉取上游模型列表并只保留免费模型。
func FetchModels(ctx context.Context) ([]map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, Base()+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", clientUA)
	res, err := Client().Do(req)
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
