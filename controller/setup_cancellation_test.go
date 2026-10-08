package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestTerminalInitializationReleasesSlotOnCancelOrTimeout(t *testing.T) {
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	for _, stage := range []string{"session", "pty", "shell"} {
		for _, disconnect := range []bool{true, false} {
			mode := "timeout"
			if disconnect {
				mode = "disconnect"
			}
			t.Run(stage+"/"+mode, func(t *testing.T) {
				terminalSlots.Lock()
				before := terminalSlots.Total
				terminalSlots.Unlock()
				address, blocked, stopServer := startLifecycleTestSSH(t, stage)
				lifetime := time.Minute
				if !disconnect {
					lifetime = 150 * time.Millisecond
				}
				socket, finished := openLifecycleTestWebSocket(t, address, func(c *gin.Context) { TermWs(c, lifetime) })
				t.Cleanup(func() { _ = socket.Close(); stopServer(); <-finished })
				select {
				case <-blocked:
				case <-time.After(time.Second):
					t.Fatal("setup stage was not reached")
				}
				if disconnect {
					_ = socket.Close()
				}
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Fatal("terminal setup did not stop")
				}
				terminalSlots.Lock()
				after := terminalSlots.Total
				terminalSlots.Unlock()
				if after != before {
					t.Fatalf("terminal slots leaked: before=%d after=%d", before, after)
				}
			})
		}
	}
}

func TestSFTPInitializationReleasesTaskOnCancelOrTimeout(t *testing.T) {
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	gin.SetMode(gin.TestMode)
	for _, stage := range []string{"session", "subsystem", "sftp_version"} {
		for _, sessionID := range []string{"", "setup-test"} {
			for _, cancelRequest := range []bool{true, false} {
				mode := "timeout"
				if cancelRequest {
					mode = "cancel"
				}
				t.Run(stage+"/"+sessionID+"/"+mode, func(t *testing.T) {
					address, blocked, stopServer := startLifecycleTestSSH(t, stage)
					info, _ := json.Marshal(map[string]any{"hostname": address, "username": "audit", "logintype": 0})
					payload, _ := json.Marshal(map[string]string{"sshInfo": base64.StdEncoding.EncodeToString(info), "path": "/", "sessionId": sessionID})
					lifetime := time.Minute
					if !cancelRequest {
						lifetime = 150 * time.Millisecond
					}
					ctx, cancel := context.WithTimeout(context.Background(), lifetime)
					c, _ := gin.CreateTestContext(httptest.NewRecorder())
					c.Request = httptest.NewRequest("POST", "/file/list", bytes.NewReader(payload)).WithContext(ctx)
					c.Request.Header.Set("Content-Type", "application/json")
					sshSlots.Lock()
					before := sshSlots.Total
					sshSlots.Unlock()
					finished := make(chan struct{})
					go func() { defer close(finished); FileList(c) }()
					t.Cleanup(func() { cancel(); stopServer(); <-finished })
					select {
					case <-blocked:
					case <-time.After(time.Second):
						t.Fatal("SFTP setup stage was not reached")
					}
					if cancelRequest {
						cancel()
					}
					select {
					case <-finished:
					case <-time.After(time.Second):
						t.Fatal("SFTP setup did not stop")
					}
					sshSlots.Lock()
					after := sshSlots.Total
					sshSlots.Unlock()
					if after != before {
						t.Fatalf("SSH tasks leaked: before=%d after=%d", before, after)
					}
				})
			}
		}
	}
}
