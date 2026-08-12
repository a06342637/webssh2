package controller

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

// fakeSSHServer is a minimal SSH server that only goes far enough to negotiate
// a pty. It records the size webssh asks for and every byte that reaches stdin,
// which is what these tests assert on: a pty opened at the wrong width, or a
// keystroke swallowed by the control path, both show up as garbled echo in the
// browser.
type fakeSSHServer struct {
	listener net.Listener

	mu           sync.Mutex
	ptyCols      uint32
	ptyRows      uint32
	ptyRequested bool
	resizes      [][2]uint32
	stdin        []byte
	closeDelay   time.Duration
}

func startFakeSSHServer(t *testing.T) *fakeSSHServer {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("build signer: %v", err)
	}

	config := &ssh.ServerConfig{
		PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &fakeSSHServer{listener: listener}
	go server.acceptLoop(config)
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func (s *fakeSSHServer) hostPort(t *testing.T) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		t.Fatalf("split addr: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return host, port
}

func (s *fakeSSHServer) acceptLoop(config *ssh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn, config)
	}
}

func (s *fakeSSHServer) handleConn(conn net.Conn, config *ssh.ServerConfig) {
	defer conn.Close()
	sshConn, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	defer sshConn.Close()
	go ssh.DiscardRequests(requests)

	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session is supported")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			return
		}
		go s.handleSession(channel, channelRequests)
	}
}

func (s *fakeSSHServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := channel.Read(buf)
			if n > 0 {
				s.mu.Lock()
				s.stdin = append(s.stdin, buf[:n]...)
				s.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	for request := range requests {
		switch request.Type {
		case "pty-req":
			var payload struct {
				Term          string
				Cols, Rows    uint32
				Width, Height uint32
				Modes         string
			}
			if err := ssh.Unmarshal(request.Payload, &payload); err == nil {
				s.mu.Lock()
				s.ptyCols, s.ptyRows, s.ptyRequested = payload.Cols, payload.Rows, true
				s.mu.Unlock()
			}
			_ = request.Reply(true, nil)
		case "window-change":
			var payload struct {
				Cols, Rows    uint32
				Width, Height uint32
			}
			if err := ssh.Unmarshal(request.Payload, &payload); err == nil {
				s.mu.Lock()
				s.resizes = append(s.resizes, [2]uint32{payload.Cols, payload.Rows})
				s.mu.Unlock()
			}
			if request.WantReply {
				_ = request.Reply(true, nil)
			}
		case "shell":
			_ = request.Reply(true, nil)
			_, _ = channel.Write([]byte("ready\r\n"))
			if s.closeDelay > 0 {
				go func() {
					time.Sleep(s.closeDelay)
					_ = channel.Close()
				}()
			}
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
}

func (s *fakeSSHServer) ptySize() (uint32, uint32, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ptyCols, s.ptyRows, s.ptyRequested
}

func (s *fakeSSHServer) lastResize() ([2]uint32, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.resizes) == 0 {
		return [2]uint32{}, false
	}
	return s.resizes[len(s.resizes)-1], true
}

func (s *fakeSSHServer) stdinText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.stdin)
}

func (s *fakeSSHServer) stdinBytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.stdin...)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// dialTerminal opens a /term WebSocket against a live TermWs handler and
// completes the SSH handshake against the fake server.
func dialTerminal(t *testing.T, server *fakeSSHServer, query string) *websocket.Conn {
	return dialTerminalWithTimeout(t, server, query, time.Minute)
}

func dialTerminalWithTimeout(t *testing.T, server *fakeSSHServer, query string, timeout time.Duration) *websocket.Conn {
	t.Helper()
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.GET("/term", func(c *gin.Context) { TermWs(c, timeout) })
	httpServer := httptest.NewServer(router)
	t.Cleanup(httpServer.Close)

	host, port := server.hostPort(t)
	info, err := json.Marshal(map[string]any{
		"username":  "tester",
		"password":  "secret",
		"hostname":  host,
		"port":      port,
		"logintype": 0,
	})
	if err != nil {
		t.Fatalf("marshal ssh info: %v", err)
	}

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/term"
	if query != "" {
		wsURL += "?" + query
	}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.WriteMessage(websocket.TextMessage, []byte(base64.StdEncoding.EncodeToString(info))); err != nil {
		t.Fatalf("send ssh info: %v", err)
	}
	waitFor(t, "pty request", func() bool {
		_, _, requested := server.ptySize()
		return requested
	})
	return conn
}

func TestTerminalPtyUsesRequestedSize(t *testing.T) {
	server := startFakeSSHServer(t)
	dialTerminal(t, server, "cols=120&rows=40")

	cols, rows, _ := server.ptySize()
	if cols != 120 || rows != 40 {
		t.Fatalf("pty opened at %dx%d, want 120x40", cols, rows)
	}
}

func TestTerminalPtyFallsBackOnInvalidSize(t *testing.T) {
	// The browser can send a size before the terminal has been laid out.
	// Opening the pty at 0 columns is what made long command echoes overlap.
	server := startFakeSSHServer(t)
	dialTerminal(t, server, "cols=undefined&rows=0")

	cols, rows, _ := server.ptySize()
	if cols != 150 || rows != 35 {
		t.Fatalf("pty opened at %dx%d, want the 150x35 fallback", cols, rows)
	}
}

func TestTerminalResizePropagatesToPty(t *testing.T) {
	server := startFakeSSHServer(t)
	conn := dialTerminal(t, server, "cols=100&rows=30")

	if err := conn.WriteMessage(websocket.TextMessage, []byte("resize:45:130")); err != nil {
		t.Fatalf("send resize: %v", err)
	}
	waitFor(t, "window-change", func() bool {
		_, ok := server.lastResize()
		return ok
	})

	size, _ := server.lastResize()
	if size[0] != 130 || size[1] != 45 {
		t.Fatalf("window changed to %dx%d, want 130x45", size[0], size[1])
	}
	if got := server.stdinText(); strings.Contains(got, "resize") {
		t.Fatalf("resize control frame leaked into stdin: %q", got)
	}
}

func TestTerminalBinaryFramesReachStdinVerbatim(t *testing.T) {
	// Regression: keystrokes and control commands used to share the text frame,
	// so pasting content that happened to be "ping" or start with "resize:"
	// disappeared instead of reaching the shell.
	server := startFakeSSHServer(t)
	conn := dialTerminal(t, server, "cols=100&rows=30")

	for _, payload := range []string{"ping", "resize:1:2", "echo 中文\n"} {
		if err := conn.WriteMessage(websocket.BinaryMessage, []byte(payload)); err != nil {
			t.Fatalf("send %q: %v", payload, err)
		}
	}
	want := "ping" + "resize:1:2" + "echo 中文\n"
	waitFor(t, "stdin to receive every binary frame", func() bool {
		return server.stdinText() == want
	})
}

func TestTerminalTextPingStaysAHeartbeat(t *testing.T) {
	server := startFakeSSHServer(t)
	conn := dialTerminal(t, server, "cols=100&rows=30")

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("send heartbeat: %v", err)
	}
	// Send a binary frame afterwards: once it lands, the heartbeat has already
	// been processed, so stdin holding only the marker proves it was dropped.
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("x")); err != nil {
		t.Fatalf("send marker: %v", err)
	}
	waitFor(t, "marker to reach stdin", func() bool {
		return server.stdinText() == "x"
	})
	if got := server.stdinText(); got != "x" {
		t.Fatalf("stdin = %q, want only the marker: text ping must not reach the shell", got)
	}
}

func TestTerminalLegacyTextInputStillWorks(t *testing.T) {
	// A browser holding a cached copy of the old page still sends keystrokes as
	// text frames; those must keep reaching the shell.
	server := startFakeSSHServer(t)
	conn := dialTerminal(t, server, "cols=100&rows=30")

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ls -la\n")); err != nil {
		t.Fatalf("send legacy input: %v", err)
	}
	waitFor(t, "legacy text input to reach stdin", func() bool {
		return server.stdinText() == "ls -la\n"
	})
}

func TestTerminalAcceptsPasteLargerThanInitialConfigLimit(t *testing.T) {
	server := startFakeSSHServer(t)
	conn := dialTerminal(t, server, "cols=100&rows=30")
	payload := bytes.Repeat([]byte("large-paste-0123456789\n"), 12000)
	if len(payload) <= websocketInitLimit {
		t.Fatalf("test payload is only %d bytes", len(payload))
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("send large paste: %v", err)
	}
	waitFor(t, "large paste to reach stdin", func() bool {
		return len(server.stdinBytes()) == len(payload)
	})
	if got := server.stdinBytes(); !bytes.Equal(got, payload) {
		t.Fatalf("large paste was corrupted: got %d bytes, want %d", len(got), len(payload))
	}
}

func TestTerminalRemoteExitClosesWebSocket(t *testing.T) {
	server := startFakeSSHServer(t)
	server.closeDelay = 25 * time.Millisecond
	conn := dialTerminal(t, server, "cols=100&rows=30")
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func TestTerminalTimeoutRacingRemoteExitDoesNotHang(t *testing.T) {
	server := startFakeSSHServer(t)
	server.closeDelay = 40 * time.Millisecond
	conn := dialTerminalWithTimeout(t, server, "cols=100&rows=30", 40*time.Millisecond)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
