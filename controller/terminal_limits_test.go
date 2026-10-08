package controller

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

func TestTerminalBudgetIsIndependentFromSSHWork(t *testing.T) {
	t.Setenv("WEBSSH_MAX_TERMINALS", "")
	t.Setenv("WEBSSH_MAX_TERMINALS_PER_CLIENT", "")
	t.Setenv("WEBSSH_MAX_CONCURRENT_SSH", "1")
	t.Setenv("WEBSSH_MAX_CONCURRENT_SSH_PER_CLIENT", "1")
	gin.SetMode(gin.TestMode)
	client := "198.51.100.241"
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/check", nil)
	ctx.Request.RemoteAddr = client + ":1234"
	workRelease, ok := acquireSSHSlot(ctx)
	if !ok {
		t.Fatal("could not reserve SSH task budget")
	}
	defer workRelease()
	for i := 0; i < 32; i++ {
		release, err := acquireTerminalSlot(client)
		if err != nil {
			t.Fatalf("terminal %d rejected while SSH task budget was occupied: %v", i+1, err)
		}
		t.Cleanup(release)
	}
	if release, err := acquireTerminalSlot(client); err == nil {
		release()
		t.Fatal("33rd terminal should reach the default client limit")
	}
}

func TestTerminalBudgetHonorsGlobalLimitAndReleasesOnce(t *testing.T) {
	t.Setenv("WEBSSH_MAX_TERMINALS", "1")
	t.Setenv("WEBSSH_MAX_TERMINALS_PER_CLIENT", "2")
	release, err := acquireTerminalSlot("198.51.100.242")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if extra, err := acquireTerminalSlot("198.51.100.243"); err == nil {
		extra()
		t.Fatal("different client bypassed global terminal limit")
	}
	release()
	release()
	acquired, err := acquireTerminalSlot("198.51.100.243")
	if err != nil {
		t.Fatal("released terminal slot was not reusable:", err)
	}
	acquired()
}

func TestTerminalLimitIsReportedOverWebSocket(t *testing.T) {
	t.Setenv("WEBSSH_MAX_TERMINALS", "1")
	t.Setenv("WEBSSH_MAX_TERMINALS_PER_CLIENT", "1")
	release, err := acquireTerminalSlot("198.51.100.244")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/term", func(c *gin.Context) { TermWs(c, time.Minute) })
	server := httptest.NewServer(router)
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/term", nil)
	if err != nil {
		t.Fatal("limit must be reported in a readable WebSocket frame:", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var message struct{ Type, Message string }
	if !strings.HasPrefix(string(data), terminalControlPrefix) {
		t.Fatalf("missing control prefix: %q", data)
	}
	if err := json.Unmarshal(data[len(terminalControlPrefix):], &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "connection-error" || !strings.Contains(message.Message, "WEBSSH_MAX_TERMINALS") {
		t.Fatalf("unhelpful rejection: %+v", message)
	}
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("rejected connection remained open")
	}
}

func TestTwelveLiveTerminalsConnectAndReleaseSlots(t *testing.T) {
	t.Setenv("WEBSSH_MAX_TERMINALS", "64")
	t.Setenv("WEBSSH_MAX_TERMINALS_PER_CLIENT", "32")
	terminalSlots.Lock()
	initial := terminalSlots.Total
	terminalSlots.Unlock()
	var connections []*websocket.Conn
	for i := 0; i < 12; i++ {
		connection := dialTerminal(t, startFakeSSHServer(t), "")
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, message, err := connection.ReadMessage()
		if err != nil || !strings.Contains(string(message), "connection-ready") {
			t.Fatalf("terminal %d not ready: %q, %v", i+1, message, err)
		}
		connections = append(connections, connection)
	}
	for _, connection := range connections {
		_ = connection.Close()
	}
	waitFor(t, "terminal slots released after socket close", func() bool {
		terminalSlots.Lock()
		defer terminalSlots.Unlock()
		return terminalSlots.Total == initial
	})
}
