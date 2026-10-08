package controller

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

type lifecycleTestSSHConn struct {
	net.Conn
	paused    atomic.Bool
	closed    chan struct{}
	closeOnce sync.Once
}

func (connection *lifecycleTestSSHConn) Read(payload []byte) (int, error) {
	count, err := connection.Conn.Read(payload)
	if connection.paused.Load() {
		<-connection.closed
		return 0, net.ErrClosed
	}
	return count, err
}

func (connection *lifecycleTestSSHConn) Close() error {
	connection.closeOnce.Do(func() { close(connection.closed) })
	return connection.Conn.Close()
}

func serveLifecycleTestSSH(ctx context.Context, listener net.Listener, configuration *ssh.ServerConfig, stage string, blocked chan<- struct{}) error {
	rawConnection, err := listener.Accept()
	if err != nil {
		return err
	}
	transport := &lifecycleTestSSHConn{Conn: rawConnection, closed: make(chan struct{})}
	defer transport.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = transport.Close() })
	defer stopClose()
	deadline, _ := ctx.Deadline()
	if err := transport.SetDeadline(deadline); err != nil {
		return err
	}
	server, channels, globalRequests, err := ssh.NewServerConn(transport, configuration)
	if err != nil {
		return err
	}
	defer server.Close()
	globalDone := make(chan struct{})
	go func() {
		defer close(globalDone)
		ssh.DiscardRequests(globalRequests)
	}()
	defer func() {
		_ = transport.Close()
		select {
		case <-globalDone:
		case <-ctx.Done():
		}
	}()
	var pending ssh.NewChannel
	select {
	case pending = <-channels:
		if pending == nil {
			return fmt.Errorf("fake SSH server received no session channel")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if pending.ChannelType() != "session" {
		return fmt.Errorf("unexpected channel type %q", pending.ChannelType())
	}
	if stage == "session" {
		close(blocked)
		<-ctx.Done()
		return nil
	}
	channel, requests, err := pending.Accept()
	if err != nil {
		return err
	}
	defer channel.Close()
	for {
		select {
		case <-ctx.Done():
			return nil
		case request, open := <-requests:
			if !open {
				return fmt.Errorf("session closed before the expected request")
			}
			switch request.Type {
			case "pty-req":
				if stage == "pty" {
					close(blocked)
					<-ctx.Done()
					return nil
				}
				if err := request.Reply(stage == "terminal" || stage == "shell", nil); err != nil {
					return err
				}
			case "shell":
				if stage == "shell" {
					close(blocked)
					<-ctx.Done()
					return nil
				}
				if stage != "terminal" {
					return fmt.Errorf("unexpected shell request")
				}
				transport.paused.Store(true)
				if err := request.Reply(true, nil); err != nil {
					return err
				}
				close(blocked)
				<-ctx.Done()
				return nil
			case "subsystem":
				if stage == "sftp_version" {
					if err := request.Reply(true, nil); err != nil {
						return err
					}
				}
				close(blocked)
				<-ctx.Done()
				return nil
			case "exec":
				if !request.WantReply {
					return fmt.Errorf("exec request did not require a reply")
				}
				close(blocked)
				if stage == "output" {
					if err := request.Reply(true, nil); err != nil {
						return err
					}
					if _, err := channel.Write(make([]byte, 2048)); err != nil {
						return err
					}
				}
				<-ctx.Done()
				return nil
			default:
				if request.WantReply {
					if err := request.Reply(false, nil); err != nil {
						return err
					}
				}
			}
		}
	}
}

func startLifecycleTestSSH(test *testing.T, stage string) (string, <-chan struct{}, func()) {
	test.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		test.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		test.Fatal(err)
	}
	configuration := &ssh.ServerConfig{NoClientAuth: true}
	configuration.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		test.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	stopListener := context.AfterFunc(ctx, func() { _ = listener.Close() })
	serverDone := make(chan error, 1)
	blocked := make(chan struct{})
	stop := func() {
		cancel()
		_ = listener.Close()
	}
	test.Cleanup(func() {
		stop()
		stopListener()
		select {
		case serverError := <-serverDone:
			if serverError != nil {
				test.Logf("fake SSH server stopped: %v", serverError)
			}
		case <-time.After(time.Second):
			test.Error("fake SSH server did not stop after forced cleanup")
		}
	})
	go func() {
		serverDone <- serveLifecycleTestSSH(ctx, listener, configuration, stage, blocked)
	}()
	return listener.Addr().String(), blocked, stop
}

func TestRunSSHCommandBoundedCancellationAndLimit(test *testing.T) {
	cases := []struct {
		stage string
		want  error
	}{
		{stage: "session", want: context.Canceled},
		{stage: "exec", want: context.Canceled},
		{stage: "output", want: errSysInfoOutputLimit},
	}
	for _, scenario := range cases {
		test.Run(scenario.stage, func(test *testing.T) {
			address, blocked, stopServer := startLifecycleTestSSH(test, scenario.stage)
			transport, err := net.DialTimeout("tcp", address, time.Second)
			if err != nil {
				test.Fatal(err)
			}
			test.Cleanup(func() { _ = transport.Close() })
			if err := transport.SetDeadline(time.Now().Add(4 * time.Second)); err != nil {
				test.Fatal(err)
			}
			connection, channels, requests, err := ssh.NewClientConn(transport, address, &ssh.ClientConfig{
				User:            "audit",
				HostKeyCallback: ssh.InsecureIgnoreHostKey(),
			})
			if err != nil {
				test.Fatal(err)
			}
			client := ssh.NewClient(connection, channels, requests)
			ctx, cancel := context.WithCancel(context.Background())
			commandDone := make(chan error, 1)
			finished := make(chan struct{})
			test.Cleanup(func() {
				cancel()
				_ = transport.Close()
				_ = client.Close()
				stopServer()
				select {
				case <-finished:
				case <-time.After(time.Second):
					test.Error("command worker did not stop after forced SSH transport close")
				}
			})
			go func() {
				defer close(finished)
				_, commandError := runSSHCommandBounded(ctx, client, "true", 1024)
				commandDone <- commandError
			}()
			select {
			case <-blocked:
			case <-time.After(time.Second):
				test.Fatalf("fake SSH server did not reach %s", scenario.stage)
			}
			if scenario.stage != "output" {
				cancel()
			}
			select {
			case commandError := <-commandDone:
				if !errors.Is(commandError, scenario.want) {
					test.Fatalf("command returned %v, want %v", commandError, scenario.want)
				}
			case <-time.After(500 * time.Millisecond):
				test.Fatalf("command did not stop at %s", scenario.stage)
			}
		})
	}
}

func openLifecycleTestWebSocket(test *testing.T, address string, handler func(*gin.Context)) (*websocket.Conn, <-chan struct{}) {
	test.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	finished := make(chan struct{})
	router.GET("/ws", func(ctx *gin.Context) {
		defer close(finished)
		handler(ctx)
	})
	server := httptest.NewServer(router)
	test.Cleanup(server.Close)
	socket, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", nil)
	if err != nil {
		test.Fatal(err)
	}
	test.Cleanup(func() { _ = socket.Close() })
	_ = socket.SetReadDeadline(time.Now().Add(time.Second))
	_ = socket.SetWriteDeadline(time.Now().Add(time.Second))
	configuration, err := json.Marshal(map[string]interface{}{
		"username":  "audit",
		"hostname":  address,
		"logintype": 0,
	})
	if err != nil {
		test.Fatal(err)
	}
	if err := socket.WriteMessage(websocket.TextMessage, []byte(base64.StdEncoding.EncodeToString(configuration))); err != nil {
		test.Fatal(err)
	}
	return socket, finished
}

func TestSysInfoNetDisconnectCancelsInitialization(test *testing.T) {
	test.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	for _, stage := range []string{"session", "exec"} {
		test.Run(stage, func(test *testing.T) {
			address, blocked, stopServer := startLifecycleTestSSH(test, stage)
			socket, finished := openLifecycleTestWebSocket(test, address, func(ctx *gin.Context) { SysInfoNetWs(ctx) })
			test.Cleanup(func() {
				_ = socket.Close()
				stopServer()
				select {
				case <-finished:
				case <-time.After(time.Second):
					test.Error("monitor handler did not stop after forced cleanup")
				}
			})
			select {
			case <-blocked:
			case <-time.After(time.Second):
				test.Fatalf("monitor did not reach %s", stage)
			}
			_ = socket.Close()
			select {
			case <-finished:
			case <-time.After(500 * time.Millisecond):
				test.Fatalf("monitor disconnect did not cancel pending %s", stage)
			}
		})
	}
}

func TestTerminalCleanupClosesUnresponsiveSSH(test *testing.T) {
	test.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	cases := []struct {
		name       string
		lifetime   time.Duration
		disconnect bool
	}{
		{name: "browser_disconnect", lifetime: time.Minute, disconnect: true},
		{name: "session_timeout", lifetime: 100 * time.Millisecond},
	}
	for _, scenario := range cases {
		test.Run(scenario.name, func(test *testing.T) {
			address, blocked, stopServer := startLifecycleTestSSH(test, "terminal")
			socket, finished := openLifecycleTestWebSocket(test, address, func(ctx *gin.Context) {
				TermWs(ctx, scenario.lifetime)
			})
			test.Cleanup(func() {
				_ = socket.Close()
				stopServer()
				select {
				case <-finished:
				case <-time.After(time.Second):
					test.Error("terminal handler did not stop after forced cleanup")
				}
			})
			select {
			case <-blocked:
			case <-time.After(time.Second):
				test.Fatal("fake SSH server did not pause after shell setup")
			}
			_, message, err := socket.ReadMessage()
			if err != nil || !strings.Contains(string(message), "connection-ready") {
				test.Fatalf("terminal did not become ready: message=%q error=%v", message, err)
			}
			if scenario.disconnect {
				_ = socket.Close()
			}
			select {
			case <-finished:
			case <-time.After(500 * time.Millisecond):
				test.Fatal("terminal cleanup waited for an SSH close reply instead of closing the transport")
			}
		})
	}
}
