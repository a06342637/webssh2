package controller

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
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
// 开放的 TCP 代理去扫内网。前端必须先用 /rdp/session 换一张一次性票据，
// 票据里锁定了目标地址和中转配置，握手时只认票据登记的目标。

const (
	rdpTicketTTL      = 90 * time.Second
	rdpTicketMaxCount = 512
)

type rdpTicket struct {
	id         string
	host       string
	port       int
	relay      core.RDPRelay
	trustScope string
	clientIP   string
	expiresAt  time.Time
	used       bool
}

var rdpTickets = struct {
	sync.Mutex
	byID map[string]*rdpTicket
}{byID: make(map[string]*rdpTicket)}

func pruneRDPTicketsLocked(now time.Time) {
	for id, ticket := range rdpTickets.byID {
		if now.After(ticket.expiresAt) || ticket.used {
			delete(rdpTickets.byID, id)
		}
	}
}

func newRDPTicketID() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// takeRDPTicket 按常数时间比对取出票据，取出即作废。
func takeRDPTicket(id string) (*rdpTicket, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, false
	}
	now := time.Now()
	rdpTickets.Lock()
	defer rdpTickets.Unlock()
	pruneRDPTicketsLocked(now)

	var found *rdpTicket
	for candidate, ticket := range rdpTickets.byID {
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(id)) == 1 {
			found = ticket
			break
		}
	}
	if found == nil || found.used || now.After(found.expiresAt) {
		return nil, false
	}
	found.used = true
	delete(rdpTickets.byID, found.id)
	return found, true
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

// rdpAllowedPorts 限制网关能连的端口。默认只放行 RDP 端口，
// 需要非标端口时用 WEBSSH_RDP_ALLOWED_PORTS 显式配置。
func rdpAllowedPorts() []int {
	raw := strings.TrimSpace(os.Getenv("WEBSSH_RDP_ALLOWED_PORTS"))
	if raw == "" {
		return []int{3389}
	}
	ports := make([]int, 0, 8)
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if port, err := strconv.Atoi(item); err == nil && port > 0 && port <= 65535 {
			ports = append(ports, port)
		}
	}
	if len(ports) == 0 {
		return []int{3389}
	}
	return ports
}

func rdpPortAllowed(port int) bool {
	for _, allowed := range rdpAllowedPorts() {
		if allowed == port {
			return true
		}
	}
	return false
}

// CreateRDPSession 发放一次性票据。前端拿到后作为 RDCleanPath 的
// proxy_auth 字段传给 WASM 客户端。
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
	if port <= 0 || port > 65535 {
		port = 3389
	}
	if !rdpPortAllowed(port) {
		responseBody.Msg = fmt.Sprintf("不支持连接端口 %d，请在 WEBSSH_RDP_ALLOWED_PORTS 中放行", port)
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
	id, err := newRDPTicketID()
	if err != nil {
		responseBody.Msg = "生成票据失败: " + err.Error()
		return &responseBody
	}

	now := time.Now()
	rdpTickets.Lock()
	pruneRDPTicketsLocked(now)
	if len(rdpTickets.byID) >= rdpTicketMaxCount {
		rdpTickets.Unlock()
		responseBody.Msg = "RDP 连接任务过多，请稍后重试"
		return &responseBody
	}
	rdpTickets.byID[id] = &rdpTicket{
		id:         id,
		host:       host,
		port:       port,
		relay:      relay,
		trustScope: trustScope,
		clientIP:   requestIP(c),
		expiresAt:  now.Add(rdpTicketTTL),
	}
	rdpTickets.Unlock()

	responseBody.Data = map[string]interface{}{
		"ticket":      id,
		"destination": net.JoinHostPort(host, strconv.Itoa(port)),
		"relay":       relay.Describe(),
		"expiresIn":   int(rdpTicketTTL / time.Second),
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

	ticket, ok := takeRDPTicket(request.ProxyAuth)
	if !ok {
		fmt.Println("rdp rejected: invalid or expired ticket")
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 403)
		return
	}

	// 票据锁定了目标。WASM 报上来的 destination 只用于核对，不作为连接依据，
	// 这样即使有人改了前端也没法把网关指向别的主机。
	host, port, err := core.ParseRDPDestination(request.Destination)
	if err != nil || !strings.EqualFold(host, ticket.host) || port != ticket.port {
		fmt.Printf("rdp rejected: destination mismatch (want %s:%d)\n", ticket.host, ticket.port)
		writeRDPError(wsConn, core.RDCleanPathErrorGeneral, 403)
		return
	}

	ctx := c.Request.Context()
	dialer := &core.RDPDialer{Relay: &ticket.relay, TrustScope: ticket.trustScope}
	handshake, err := core.PerformRDPHandshake(ctx, dialer, ticket.host, ticket.port, request.X224ConnectionPDU)
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
			if _, err := handshake.Conn.Write(payload); err != nil {
				rdpDebugf("relay: tls write failed: %v", err)
				return
			}
		}
	}()

	<-done
	workers.Wait()
}
