package core

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

// RelayKind 是 RDP 流量到达目标机之前经过的中转方式。
const (
	RelayNone   = "none"
	RelaySocks5 = "socks5"
	RelaySSH    = "ssh"
)

const (
	rdpDialTimeout      = 12 * time.Second
	rdpHandshakeTimeout = 20 * time.Second
)

// RDPRelay 描述一跳中转。SSH 模式复用 SSHClient 的拨号能力，
// 所以这里的字段命名刻意和 SSH 表单保持一致。
type RDPRelay struct {
	Kind       string `json:"kind"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	PrivateKey string `json:"privateKey"`
	Passphrase string `json:"passphrase"`
	// LoginType 与 SSHClient 一致: 0=密码, 1=私钥。
	LoginType int `json:"loginType"`
}

// Normalize 把中转配置整理成可用状态，顺带补默认端口。
func (r *RDPRelay) Normalize() {
	if r == nil {
		return
	}
	r.Kind = strings.ToLower(strings.TrimSpace(r.Kind))
	switch r.Kind {
	case RelaySocks5:
		r.Host, r.Port = normalizeHostPort(r.Host, r.Port, 1080)
	case RelaySSH:
		r.Host, r.Port = normalizeHostPort(r.Host, r.Port, 22)
	default:
		r.Kind = RelayNone
	}
	if strings.TrimSpace(r.Host) == "" {
		r.Kind = RelayNone
	}
}

// Enabled 表示这次连接需要走中转。
func (r *RDPRelay) Enabled() bool {
	return r != nil && r.Kind != "" && r.Kind != RelayNone && strings.TrimSpace(r.Host) != ""
}

// Describe 给出一行可读的中转说明，用于回显给前端。
func (r *RDPRelay) Describe() string {
	if !r.Enabled() {
		return "直连"
	}
	switch r.Kind {
	case RelaySocks5:
		return "SOCKS5 " + net.JoinHostPort(r.Host, strconv.Itoa(r.Port))
	case RelaySSH:
		return "SSH 跳板 " + r.Username + "@" + net.JoinHostPort(r.Host, strconv.Itoa(r.Port))
	default:
		return "直连"
	}
}

// RDPDialer 建立到目标 RDP 服务的 TCP 连接，必要时经过一跳中转。
// closer 用来释放中转自身持有的资源（例如 SSH 会话），调用方在
// 连接结束后必须调用它。
type RDPDialer struct {
	Relay      *RDPRelay
	TrustScope string
}

type dialResult struct {
	conn  net.Conn
	close func()
}

// Dial 连接 host:port，返回的 close 释放中转资源。
func (d *RDPDialer) Dial(ctx context.Context, host string, port int) (net.Conn, func(), error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	noop := func() {}

	if !d.Relay.Enabled() {
		dialer := &net.Dialer{Timeout: rdpDialTimeout, KeepAlive: 30 * time.Second, FallbackDelay: 100 * time.Millisecond}
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, noop, fmt.Errorf("连接 %s 失败: %w", addr, err)
		}
		tuneInteractiveConn(conn)
		return conn, noop, nil
	}

	switch d.Relay.Kind {
	case RelaySocks5:
		result, err := d.dialViaSocks5(ctx, addr)
		if err != nil {
			return nil, noop, err
		}
		return result.conn, result.close, nil
	case RelaySSH:
		result, err := d.dialViaSSH(ctx, addr)
		if err != nil {
			return nil, noop, err
		}
		return result.conn, result.close, nil
	default:
		return nil, noop, fmt.Errorf("不支持的中转类型: %s", d.Relay.Kind)
	}
}

func (d *RDPDialer) dialViaSocks5(ctx context.Context, addr string) (dialResult, error) {
	relay := d.Relay
	proxyAddr := net.JoinHostPort(relay.Host, strconv.Itoa(relay.Port))
	var auth *proxy.Auth
	if strings.TrimSpace(relay.Username) != "" {
		auth = &proxy.Auth{User: relay.Username, Password: relay.Password}
	}
	base := &net.Dialer{Timeout: rdpDialTimeout, KeepAlive: 30 * time.Second}
	dialer, err := proxy.SOCKS5("tcp", proxyAddr, auth, base)
	if err != nil {
		return dialResult{}, fmt.Errorf("创建 SOCKS5 中转失败: %w", err)
	}
	contextDialer, ok := dialer.(proxy.ContextDialer)
	if !ok {
		return dialResult{}, fmt.Errorf("SOCKS5 中转不支持带超时的拨号")
	}
	conn, err := contextDialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return dialResult{}, fmt.Errorf("经 SOCKS5 %s 连接 %s 失败: %w", proxyAddr, addr, err)
	}
	tuneInteractiveConn(conn)
	return dialResult{conn: conn, close: func() {}}, nil
}

func (d *RDPDialer) dialViaSSH(ctx context.Context, addr string) (dialResult, error) {
	relay := d.Relay
	jump := NewSSHClient()
	jump.Hostname = relay.Host
	jump.Port = relay.Port
	jump.Username = relay.Username
	jump.Password = relay.Password
	jump.PrivateKey = relay.PrivateKey
	jump.Passphrase = relay.Passphrase
	jump.LoginType = relay.LoginType
	jump.TrustScope = d.TrustScope
	// 跳板机的主机密钥沿用 SSH 侧那套 TOFU 策略：首次连接记录指纹，
	// 之后指纹变化会直接报错，不会静默接受。
	jump.HostKeyAction = ""

	if err := jump.GenerateClient(); err != nil {
		return dialResult{}, fmt.Errorf("连接 SSH 跳板失败: %w", err)
	}

	type dialOutcome struct {
		conn net.Conn
		err  error
	}
	done := make(chan dialOutcome, 1)
	go func() {
		// x/crypto/ssh 的 Dial 没有 context 版本，用 goroutine + select
		// 保证外层超时能生效。
		conn, err := jump.Client.Dial("tcp", addr)
		done <- dialOutcome{conn: conn, err: err}
	}()

	select {
	case <-ctx.Done():
		jump.Close()
		return dialResult{}, fmt.Errorf("经 SSH 跳板连接 %s 超时", addr)
	case outcome := <-done:
		if outcome.err != nil {
			jump.Close()
			return dialResult{}, fmt.Errorf("SSH 跳板转发到 %s 失败: %w", addr, outcome.err)
		}
		tuneInteractiveConn(outcome.conn)
		return dialResult{conn: outcome.conn, close: jump.Close}, nil
	}
}

// ParseRDPDestination 解析 RDCleanPath 里的 "host:port"，缺省端口 3389。
func ParseRDPDestination(destination string) (string, int, error) {
	destination = strings.TrimSpace(destination)
	if destination == "" {
		return "", 0, fmt.Errorf("目标地址为空")
	}
	host, port := normalizeHostPort(destination, 0, 3389)
	if strings.TrimSpace(host) == "" {
		return "", 0, fmt.Errorf("目标地址无效: %s", destination)
	}
	return host, port, nil
}

const rdpX224MaxPacket = 64 << 10

func readRDPX224Response(conn io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil, fmt.Errorf("RDP 服务端在返回 X.224 响应前关闭了连接（通常是目标端口不是 RDP 服务）")
		}
		return nil, fmt.Errorf("读取 X.224 响应头失败: %w", err)
	}
	if header[0] != 3 || header[1] != 0 {
		return nil, fmt.Errorf("RDP 服务端返回了无效的 TPKT 响应头")
	}
	packetLength := int(binary.BigEndian.Uint16(header[2:4]))
	if packetLength < len(header) || packetLength > rdpX224MaxPacket {
		return nil, fmt.Errorf("RDP X.224 响应长度无效: %d", packetLength)
	}
	packet := make([]byte, packetLength)
	copy(packet, header)
	if _, err := io.ReadFull(conn, packet[len(header):]); err != nil {
		return nil, fmt.Errorf("读取完整 X.224 响应失败: %w", err)
	}
	return packet, nil
}

// RDPHandshake 是 RDCleanPath 网关握手的结果。
type RDPHandshake struct {
	X224Response []byte
	CertChain    [][]byte
	Conn         *tls.Conn
	ServerAddr   string
	Release      func()
}

// PerformRDPHandshake 执行 RDCleanPath 要求的前半段握手：
// TCP 连接 → 转发 X.224 Connection Request → 读回 Connection Confirm →
// 升级 TLS → 取出服务端证书链。之后的 CredSSP/NLA 由浏览器里的 WASM
// 在这条 TLS 通道内完成，网关只做透明转发。
func PerformRDPHandshake(ctx context.Context, dialer *RDPDialer, host string, port int, x224Request []byte) (*RDPHandshake, error) {
	dialCtx, cancelDial := context.WithTimeout(ctx, rdpDialTimeout)
	conn, release, err := dialer.Dial(dialCtx, host, port)
	cancelDial()
	if err != nil {
		return nil, err
	}

	cleanup := func() {
		_ = conn.Close()
		release()
	}

	deadline := time.Now().Add(rdpHandshakeTimeout)
	if err := conn.SetDeadline(deadline); err != nil {
		cleanup()
		return nil, fmt.Errorf("设置握手超时失败: %w", err)
	}

	if err := writeAll(conn, x224Request); err != nil {
		cleanup()
		return nil, fmt.Errorf("发送 X.224 连接请求失败: %w", err)
	}

	// TCP is a byte stream: one Read is not guaranteed to contain the full
	// X.224/TPKT response. Read the fixed TPKT header first, validate its
	// declared length, then read the remainder exactly.
	x224Response, err := readRDPX224Response(conn)
	if err != nil {
		cleanup()
		return nil, err
	}

	// RDP 服务端基本都用自签名证书，这里不做校验；证书链会原样交给
	// 浏览器，由 WASM 侧做 CredSSP 的通道绑定。
	//
	// MaxVersion 必须压到 TLS 1.2：CredSSP 的通道绑定依赖 TLS 1.2 的
	// 握手语义，协商到 TLS 1.3 时 Windows 会在 CredSSP 阶段直接回一个
	// internal error alert 把连接掐掉。FreeRDP 等原生客户端同样这么做。
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS10,
		MaxVersion:         tls.VersionTLS12,
	})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		cleanup()
		return nil, fmt.Errorf("TLS 握手失败: %w", err)
	}
	if err := tlsConn.SetDeadline(time.Time{}); err != nil {
		_ = tlsConn.Close()
		release()
		return nil, fmt.Errorf("清除握手超时失败: %w", err)
	}

	certChain := make([][]byte, 0, 4)
	for _, cert := range tlsConn.ConnectionState().PeerCertificates {
		certChain = append(certChain, cert.Raw)
	}

	return &RDPHandshake{
		X224Response: x224Response,
		CertChain:    certChain,
		Conn:         tlsConn,
		ServerAddr:   net.JoinHostPort(host, strconv.Itoa(port)),
		Release: func() {
			_ = tlsConn.Close()
			release()
		},
	}, nil
}
