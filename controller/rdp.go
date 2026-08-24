package controller

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// RDP 网关的工作方式：浏览器里的 IronRDP WASM 客户端把 RDCleanPath 握手
// 报文发到这里，网关代它完成 TCP 连接、X.224 协商和 TLS 握手，然后退化成
// 一条透明的字节管道。RDP 协议本身（含 CredSSP/NLA）全部在浏览器里解析，
// 网关不参与，也就不需要服务端转码。
//
// 目标地址不是从 WebSocket 请求里直接取的：那样任何人都能拿这个端点当成
// 开放的 TCP 代理去扫内网。前端先用 /rdp/session 换取一个短期加密凭证；
// 凭证封装目标地址和中转配置，服务端不保存任何逐连接票据或中转凭据。

const (
	rdpCredentialTTL        = 90 * time.Second
	rdpCredentialMaxEncoded = 56 << 10
	rdpCredentialVersion    = 1
)

var rdpCredentialSecret = struct {
	sync.Once
	key [32]byte
	err error
}{}

var rdpCredentialAAD = []byte("webssh-rdp-credential-v1")

type rdpCredential struct {
	Version    int           `json:"version"`
	Host       string        `json:"host"`
	Port       int           `json:"port"`
	Relay      core.RDPRelay `json:"relay"`
	TrustScope string        `json:"trustScope"`
	ClientIP   string        `json:"clientIP"`
	ExpiresAt  int64         `json:"expiresAt"`
}

func currentRDPCredentialKey() ([]byte, error) {
	rdpCredentialSecret.Do(func() {
		_, rdpCredentialSecret.err = rand.Read(rdpCredentialSecret.key[:])
	})
	if rdpCredentialSecret.err != nil {
		return nil, rdpCredentialSecret.err
	}
	return rdpCredentialSecret.key[:], nil
}

// sealRDPCredential creates an encrypted, authenticated, short-lived credential.
// The server stores no per-connection ticket or relay secret: every field needed
// for the handshake travels inside this credential and is recovered only after
// AES-GCM authentication succeeds.
func sealRDPCredential(payload rdpCredential) (string, error) {
	key, err := currentRDPCredentialKey()
	if err != nil {
		return "", err
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipherNewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, plaintext, rdpCredentialAAD)
	encoded := base64.RawURLEncoding.EncodeToString(sealed)
	if len(encoded) > rdpCredentialMaxEncoded {
		return "", fmt.Errorf("RDP 中转配置过大")
	}
	return encoded, nil
}

// cipherNewGCM is a variable only to keep credential cryptography easy to
// exercise in focused tests without retaining any issued credential state.
var cipherNewGCM = func(block cipher.Block) (cipher.AEAD, error) {
	return cipher.NewGCM(block)
}

func openRDPCredential(encoded string, clientIP string, trustScope string, now time.Time) (*rdpCredential, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" || len(encoded) > rdpCredentialMaxEncoded {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	key, err := currentRDPCredentialKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipherNewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(raw) < aead.NonceSize() {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	nonce, ciphertext := raw[:aead.NonceSize()], raw[aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, ciphertext, rdpCredentialAAD)
	if err != nil {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	var credential rdpCredential
	if err := json.Unmarshal(plaintext, &credential); err != nil {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	if credential.Version != rdpCredentialVersion || credential.Host == "" || credential.Port < 1 || credential.Port > 65535 {
		return nil, fmt.Errorf("RDP 连接凭证无效")
	}
	if credential.ExpiresAt <= now.Unix() {
		return nil, fmt.Errorf("RDP 连接凭证已过期")
	}
	if credential.ClientIP == "" || credential.ClientIP != clientIP {
		return nil, fmt.Errorf("RDP 连接凭证来源不匹配")
	}
	if credential.TrustScope == "" || subtle.ConstantTimeCompare([]byte(credential.TrustScope), []byte(trustScope)) != 1 {
		return nil, fmt.Errorf("RDP 连接凭证浏览器不匹配")
	}
	credential.Relay.Normalize()
	return &credential, nil
}

type rdpSessionRequest struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	Relay    struct {
		Kind       string `json:"kind"`
		Host       string `json:"host"`
		Port       int    `json:"port"`
		Username   string `json:"username"`
		Password   string `json:"password"`
		PrivateKey string `json:"privateKey"`
		Passphrase string `json:"passphrase"`
		LoginType  int    `json:"loginType"`
	} `json:"relay"`
}

// CreateRDPSession returns an encrypted stateless connection credential. No
// ticket is inserted into a map, database, file, cache, or other server store.
func CreateRDPSession(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)

	var request rdpSessionRequest
	if err := bindStrictJSON(c, &request); err != nil {
		responseBody.Msg = "invalid request: " + err.Error()
		return &responseBody
	}

	host := strings.TrimSpace(request.Hostname)
	if host == "" {
		responseBody.Msg = "missing hostname"
		return &responseBody
	}
	port := request.Port
	if port == 0 {
		port = 3389
	}
	if port < 1 || port > 65535 {
		responseBody.Msg = fmt.Sprintf("invalid RDP port %d", port)
		return &responseBody
	}

	relay := core.RDPRelay{
		Kind:       request.Relay.Kind,
		Host:       request.Relay.Host,
		Port:       request.Relay.Port,
		Username:   request.Relay.Username,
		Password:   request.Relay.Password,
		PrivateKey: request.Relay.PrivateKey,
		Passphrase: request.Relay.Passphrase,
		LoginType:  request.Relay.LoginType,
	}
	relay.Normalize()
	if relay.Enabled() && relay.Kind == core.RelaySSH && strings.TrimSpace(relay.Username) == "" {
		responseBody.Msg = "SSH 跳板缺少用户名"
		return &responseBody
	}

	trustScope, err := requestTrustScope(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	now := time.Now()
	credential, err := sealRDPCredential(rdpCredential{
		Version:    rdpCredentialVersion,
		Host:       host,
		Port:       port,
		Relay:      relay,
		TrustScope: trustScope,
		ClientIP:   requestIP(c),
		ExpiresAt:  now.Add(rdpCredentialTTL).Unix(),
	})
	if err != nil {
		responseBody.Msg = "生成 RDP 连接凭证失败: " + err.Error()
		return &responseBody
	}

	responseBody.Data = map[string]interface{}{
		"credential":  credential,
		"destination": net.JoinHostPort(host, strconv.Itoa(port)),
		"relay":       relay.Describe(),
		"expiresIn":   int(rdpCredentialTTL / time.Second),
	}
	return &responseBody
}

// RdpWs 处理 RDCleanPath 握手并把连接转成透明管道。
func RdpWs(c *gin.Context) {
	release, ok := acquireRDPSlot(c)
	if !ok {
		return
	}
	defer release()

	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Println("rdp ws upgrade error:", err)
		return
	}
	defer wsConn.Close()

	// 握手报文很小；正式转发开始后才放开读取上限。
	wsConn.SetReadLimit(websocketInitLimit)
	_ = wsConn.SetReadDeadline(time.Now().Add(websocketInitTimeout))
	messageType, initMsg, err := wsConn.ReadMessage()
	if err != nil {
		fmt.Println("rdp read RDCleanPath request error:", err)
		return
	}
	_ = wsConn.SetReadDeadline(time.Time{})
	if messageType != websocket.BinaryMessage {
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 400)
		return
	}

	request, err := core.ParseRDCleanPathRequest(initMsg)
	if err != nil {
		fmt.Println("rdp parse RDCleanPath request error:", err)
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 400)
		return
	}

	trustScope, err := requestTrustScope(c)
	if err != nil {
		fmt.Println("rdp rejected: unavailable browser scope")
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 403)
		return
	}
	credential, err := openRDPCredential(request.ProxyAuth, requestIP(c), trustScope, time.Now())
	if err != nil {
		fmt.Println("rdp rejected:", err)
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 403)
		return
	}

	// The encrypted credential locks the target. The WASM destination is only
	// cross-checked and is never used as an authority for server-side dialing.
	host, port, err := core.ParseRDPDestination(request.Destination)
	if err != nil || !strings.EqualFold(host, credential.Host) || port != credential.Port {
		fmt.Printf("rdp rejected: destination mismatch (want %s:%d)\n", credential.Host, credential.Port)
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 403)
		return
	}

	ctx := c.Request.Context()
	dialer := &core.RDPDialer{Relay: &credential.Relay, TrustScope: credential.TrustScope}
	handshake, err := core.PerformRDPHandshake(ctx, dialer, credential.Host, credential.Port, request.X224ConnectionPDU)
	if err != nil {
		fmt.Println("rdp handshake error:", err)
		writeRDPError(wsConn, core.RDCleanPathErrorNegotiation, 502)
		return
	}
	defer handshake.Release()

	unregisterCloser, registered := registerRuntimeCloser(func() {
		_ = wsConn.Close()
		handshake.Release()
	})
	if !registered {
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 503)
		return
	}
	defer unregisterCloser()

	rdpDebugf("handshake ok: %s, x224=%d bytes, certs=%d", handshake.ServerAddr, len(handshake.X224Response), len(handshake.CertChain))
	response := core.BuildRDCleanPathResponse(handshake.ServerAddr, handshake.X224Response, handshake.CertChain)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, response); err != nil {
		fmt.Println("rdp write RDCleanPath response error:", err)
		return
	}

	relayRDPTraffic(wsConn, handshake)
}

// rdpDebugf 只在 WEBSSH_RDP_DEBUG=true 时输出转发层细节，
// 正常运行时这条链路上每秒都有事件，不适合常开日志。
func rdpDebugf(format string, args ...interface{}) {
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("WEBSSH_RDP_DEBUG")), "true") {
		return
	}
	fmt.Printf("[rdp] "+format+"\n", args...)
}

func writeRDPError(wsConn *websocket.Conn, errorCode int, httpStatus int) {
	payload := core.BuildRDCleanPathError(errorCode, httpStatus)
	_ = wsConn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = wsConn.WriteMessage(websocket.BinaryMessage, payload)
	_ = wsConn.SetWriteDeadline(time.Time{})
}

func writeRDPAll(w io.Writer, payload []byte) error {
	for len(payload) > 0 {
		n, err := w.Write(payload)
		if n > 0 {
			payload = payload[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// relayRDPTraffic 在 WebSocket 与 TLS 连接之间做双向透明转发。
// 这里刻意不做任何缓冲合并：RDP 是交互协议，攒包会直接变成手感上的延迟。
func relayRDPTraffic(wsConn *websocket.Conn, handshake *core.RDPHandshake) {
	wsConn.SetReadLimit(websocketRDPFrameLimit)

	var writeMu sync.Mutex
	done := make(chan struct{})
	var closeOnce sync.Once
	stop := func() {
		closeOnce.Do(func() {
			close(done)
			_ = wsConn.Close()
			handshake.Release()
		})
	}

	var workers sync.WaitGroup
	workers.Add(2)

	// 目标机 → 浏览器
	go func() {
		defer workers.Done()
		defer stop()
		buf := make([]byte, 32<<10)
		for {
			n, err := handshake.Conn.Read(buf)
			if n > 0 {
				writeMu.Lock()
				err := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n])
				writeMu.Unlock()
				if err != nil {
					rdpDebugf("relay: ws write failed after %d bytes: %v", n, err)
					return
				}
			}
			if err != nil {
				rdpDebugf("relay: tls read ended: %v", err)
				return
			}
		}
	}()

	// 浏览器 → 目标机
	go func() {
		defer workers.Done()
		defer stop()
		for {
			messageType, payload, err := wsConn.ReadMessage()
			if err != nil {
				rdpDebugf("relay: ws read ended: %v", err)
				return
			}
			if messageType != websocket.BinaryMessage || len(payload) == 0 {
				continue
			}
			if err := writeRDPAll(handshake.Conn, payload); err != nil {
				rdpDebugf("relay: tls write failed: %v", err)
				return
			}
		}
	}()

	<-done
	workers.Wait()
}
