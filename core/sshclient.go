package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

func DecodedMsgToSSHClient(sshInfo string) (SSHClient, error) {
	client := NewSSHClient()
	decoded, err := base64.StdEncoding.DecodeString(sshInfo)
	if err != nil {
		return client, err
	}
	err = json.Unmarshal(decoded, &client)
	if err != nil {
		return client, err
	}
	normalizeSSHClientAddress(&client)
	return client, nil
}

func normalizePort(port int, fallback int) int {
	if port < 1 || port > 65535 {
		return fallback
	}
	return port
}

func normalizeHostPort(host string, port int, fallbackPort int) (string, int) {
	host = strings.TrimSpace(host)
	port = normalizePort(port, fallbackPort)
	if host == "" {
		return host, port
	}

	if h, p, err := net.SplitHostPort(host); err == nil {
		if parsedPort, parseErr := strconv.Atoi(p); parseErr == nil {
			port = normalizePort(parsedPort, port)
		}
		return strings.TrimSpace(h), port
	}

	if strings.HasPrefix(host, "[") {
		if end := strings.LastIndex(host, "]"); end > 0 {
			innerHost := strings.TrimSpace(host[1:end])
			if rest := strings.TrimSpace(host[end+1:]); strings.HasPrefix(rest, ":") {
				if parsedPort, err := strconv.Atoi(strings.TrimPrefix(rest, ":")); err == nil {
					port = normalizePort(parsedPort, port)
				}
			}
			return innerHost, port
		}
	}

	if strings.Count(host, ":") == 1 {
		if idx := strings.LastIndex(host, ":"); idx > 0 && idx < len(host)-1 {
			portPart := host[idx+1:]
			if parsedPort, err := strconv.Atoi(portPart); err == nil {
				return strings.TrimSpace(host[:idx]), normalizePort(parsedPort, port)
			}
		}
	}

	return host, port
}

func normalizeSSHClientAddress(client *SSHClient) {
	client.Hostname, client.Port = normalizeHostPort(client.Hostname, client.Port, 22)
	if client.ProxyHost != "" {
		client.ProxyHost, client.ProxyPort = normalizeHostPort(client.ProxyHost, client.ProxyPort, 1080)
	}
}

const sshConnectTimeout = 5 * time.Second

func tuneInteractiveConn(conn net.Conn) {
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		// Go enables TCP_NODELAY by default for TCP connections; set it explicitly
		// because proxied connections may come from a custom dialer.
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(30 * time.Second)
	}
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if n > 0 {
			p = p[n:]
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

func sshClientFromConn(conn net.Conn, addr string, clientConfig *ssh.ClientConfig, timeout time.Duration) (*ssh.Client, error) {
	tuneInteractiveConn(conn)
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed to set ssh handshake deadline: %v", err)
	}
	connection, channels, requests, err := ssh.NewClientConn(conn, addr, clientConfig)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("failed to clear ssh handshake deadline: %v", err)
	}
	return ssh.NewClient(connection, channels, requests), nil
}

func (sclient *SSHClient) GenerateClient() error {
	var (
		auth         []ssh.AuthMethod
		addr         string
		clientConfig *ssh.ClientConfig
		config       ssh.Config
		hostKeyCheck ssh.HostKeyCallback
		err          error
	)
	auth = make([]ssh.AuthMethod, 0)
	normalizeSSHClientAddress(sclient)

	if sclient.LoginType == 0 {
		auth = append(auth, ssh.Password(sclient.Password))
		auth = append(auth, ssh.KeyboardInteractive(
			func(user, instruction string, questions []string, echos []bool) (answers []string, err error) {
				answers = make([]string, len(questions))
				for i := range questions {
					answers[i] = sclient.Password
				}
				return answers, nil
			},
		))
	} else {
		var signer ssh.Signer
		if sclient.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(sclient.PrivateKey), []byte(sclient.Passphrase))
			if err != nil {
				return fmt.Errorf("failed to parse private key with passphrase: %v", err)
			}
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(sclient.PrivateKey))
			if err != nil {
				return fmt.Errorf("failed to parse private key: %v", err)
			}
		}
		auth = append(auth, ssh.PublicKeys(signer))
	}

	config.SetDefaults()
	if strings.EqualFold(strings.TrimSpace(os.Getenv("WEBSSH_ALLOW_LEGACY_CIPHERS")), "true") {
		config.Ciphers = append(config.Ciphers, "aes128-cbc", "3des-cbc", "aes192-cbc", "aes256-cbc")
	}
	hostKeyCheck, err = hostKeyCallback()
	if err != nil {
		return err
	}
	clientConfig = &ssh.ClientConfig{
		User:            sclient.Username,
		Auth:            auth,
		Timeout:         sshConnectTimeout,
		Config:          config,
		HostKeyCallback: hostKeyCheck,
	}
	if sclient.Port == 0 {
		sclient.Port = 22
	}
	// JoinHostPort automatically converts a bare IPv6 literal into [IPv6]:port.
	addr = net.JoinHostPort(sclient.Hostname, strconv.Itoa(sclient.Port))

	networkDialer := &net.Dialer{Timeout: sshConnectTimeout, KeepAlive: 30 * time.Second, FallbackDelay: 100 * time.Millisecond}
	if sclient.ProxyHost != "" {
		if sclient.ProxyPort == 0 {
			sclient.ProxyPort = 1080
		}
		proxyAddr := net.JoinHostPort(sclient.ProxyHost, strconv.Itoa(sclient.ProxyPort))
		var proxyAuth *proxy.Auth
		if sclient.ProxyUser != "" {
			proxyAuth = &proxy.Auth{User: sclient.ProxyUser, Password: sclient.ProxyPass}
		}
		dialer, err := proxy.SOCKS5("tcp", proxyAddr, proxyAuth, networkDialer)
		if err != nil {
			return fmt.Errorf("failed to create socks5 proxy: %v", err)
		}
		contextDialer, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return fmt.Errorf("socks5 proxy does not support bounded dialing")
		}
		ctx, cancel := context.WithTimeout(context.Background(), sshConnectTimeout)
		conn, err := contextDialer.DialContext(ctx, "tcp", addr)
		cancel()
		if err != nil {
			return fmt.Errorf("failed to connect via proxy: %v", err)
		}
		client, err := sshClientFromConn(conn, addr, clientConfig, sshConnectTimeout)
		if err != nil {
			return fmt.Errorf("failed to ssh handshake via proxy: %v", err)
		}
		sclient.Client = client
		return nil
	}

	conn, err := networkDialer.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to connect: %v", err)
	}
	client, err := sshClientFromConn(conn, addr, clientConfig, sshConnectTimeout)
	if err != nil {
		return fmt.Errorf("failed to ssh handshake: %v", err)
	}
	sclient.Client = client
	return nil
}

func (sclient *SSHClient) InitTerminal(ws *websocket.Conn, rows, cols int) *SSHClient {
	sshSession, err := sclient.Client.NewSession()
	if err != nil {
		log.Println(err)
		return nil
	}
	sclient.Session = sshSession
	stdinPipe, err := sshSession.StdinPipe()
	if err != nil {
		log.Println(err)
		sshSession.Close()
		return nil
	}
	sclient.StdinPipe = stdinPipe
	if sclient.wsWriteMu == nil {
		sclient.wsWriteMu = &sync.Mutex{}
	}
	wsOutput := new(wsOutput)
	sshSession.Stdout = wsOutput
	sshSession.Stderr = wsOutput
	wsOutput.ws = ws
	wsOutput.mu = sclient.wsWriteMu
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200,
		ssh.TTY_OP_OSPEED: 115200,
	}
	if err := sshSession.RequestPty("xterm", rows, cols, modes); err != nil {
		log.Println(err)
		sshSession.Close()
		return nil
	}
	if err := sshSession.Shell(); err != nil {
		log.Println(err)
		sshSession.Close()
		return nil
	}
	return sclient
}

func (sclient *SSHClient) Connect(ws *websocket.Conn, timeout time.Duration, closeTip string) {
	stopCh := make(chan struct{})
	go func() {
		for {
			_, p, err := ws.ReadMessage()
			if err != nil {
				close(stopCh)
				return
			}
			// Keep the common keystroke path byte-oriented. Converting every
			// input frame to string creates avoidable allocations; only resize
			// control frames need text parsing.
			if len(p) == 4 && p[0] == 'p' && p[1] == 'i' && p[2] == 'n' && p[3] == 'g' {
				continue
			}
			if len(p) >= 7 && p[0] == 'r' && p[1] == 'e' && p[2] == 's' && p[3] == 'i' && p[4] == 'z' && p[5] == 'e' && p[6] == ':' {
				resizeSlice := strings.Split(string(p), ":")
				if len(resizeSlice) != 3 {
					continue
				}
				rows, _ := strconv.Atoi(resizeSlice[1])
				cols, _ := strconv.Atoi(resizeSlice[2])
				if rows <= 0 || cols <= 0 {
					continue
				}
				err := sclient.Session.WindowChange(rows, cols)
				if err != nil {
					log.Println(err)
					close(stopCh)
					return
				}
				continue
			}
			err = writeAll(sclient.StdinPipe, p)
			if err != nil {
				close(stopCh)
				return
			}
		}
	}()

	defer func() {
		ws.Close()
		sclient.Close()
		if err := recover(); err != nil {
			log.Println(err)
		}
	}()

	stopTimer := time.NewTimer(timeout)
	defer stopTimer.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-stopTimer.C:
			if sclient.wsWriteMu == nil {
				sclient.wsWriteMu = &sync.Mutex{}
			}
			sclient.wsWriteMu.Lock()
			_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\033[33m%s\033[0m", closeTip)))
			sclient.wsWriteMu.Unlock()
			return
		}
	}
}
