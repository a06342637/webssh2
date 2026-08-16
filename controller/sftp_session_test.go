package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func resetSFTPSessionRegistryForTest() {
	sftpSessionRegistry.Lock()
	entries := make([]*sftpSessionEntry, 0, len(sftpSessionRegistry.entries))
	for _, entry := range sftpSessionRegistry.entries {
		entries = append(entries, entry)
	}
	sftpSessionRegistry.entries = make(map[string]*sftpSessionEntry)
	sftpSessionRegistry.clients = make(map[string]int)
	sftpSessionRegistry.Unlock()
	for _, entry := range entries {
		entry.opMu.Lock()
		entry.closed = true
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
			entry.idleTimer = nil
		}
		if entry.client != nil {
			entry.client.Close()
			entry.client = nil
		}
		entry.opMu.Unlock()
	}
}

func sftpSessionTestSSHInfo(t *testing.T) string {
	t.Helper()
	payload, err := json.Marshal(core.SSHClient{
		Username:   "root",
		Password:   "pool-secret",
		Hostname:   "example.test",
		Port:       22,
		TrustScope: strings.Repeat("a", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(payload)
}

func callFileListForSessionTest(t *testing.T, sshInfo, sessionID, path string) *ResponseBody {
	t.Helper()
	body := fmt.Sprintf(`{"sshInfo":%q,"sessionId":%q,"path":%q}`, sshInfo, sessionID, path)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/list", strings.NewReader(body))
	ctx.Request.RemoteAddr = "198.51.100.20:43210"
	ctx.Request.Header.Set("Content-Type", "application/json")
	return FileList(ctx)
}

func TestFileListReusesPersistentSFTPSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resetSFTPSessionRegistryForTest()
	t.Cleanup(resetSFTPSessionRegistryForTest)
	oldFactory := createSFTPSessionClient
	t.Cleanup(func() { createSFTPSessionClient = oldFactory })
	var creates atomic.Int32
	createSFTPSessionClient = func(client core.SSHClient) (*core.SSHClient, error) {
		creates.Add(1)
		client.Sftp = newEditorTestSFTPClient(t)
		return &client, nil
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello"), 0o640); err != nil {
		t.Fatal(err)
	}
	sshInfo := sftpSessionTestSSHInfo(t)
	path := editorTestRemotePath(dir)
	for i := 0; i < 2; i++ {
		response := callFileListForSessionTest(t, sshInfo, "session-reuse-123", path)
		if response.Msg != "success" {
			t.Fatalf("FileList() response %d = %q", i, response.Msg)
		}
	}
	if got := creates.Load(); got != 1 {
		t.Fatalf("SFTP client creations = %d, want 1", got)
	}
	var entries []*sftpSessionEntry
	sftpSessionRegistry.Lock()
	for _, entry := range sftpSessionRegistry.entries {
		entries = append(entries, entry)
	}
	sftpSessionRegistry.Unlock()
	for _, entry := range entries {
		entry.opMu.Lock()
		if entry.client.Password != "" || entry.client.PrivateKey != "" || entry.client.Passphrase != "" || entry.client.ProxyPass != "" {
			entry.opMu.Unlock()
			t.Fatal("persistent SFTP session retained plaintext credentials")
		}
		entry.opMu.Unlock()
	}
}

func TestCloneSFTPClientConfigDoesNotCopyRuntimeState(t *testing.T) {
	source := core.NewSSHClient()
	source.Username = "root"
	source.Password = "secret"
	source.Hostname = "example.test"
	source.Port = 2222
	source.LoginType = 2
	source.PrivateKey = "private-key"
	source.Passphrase = "passphrase"
	source.ProxyHost = "proxy.test"
	source.ProxyPort = 1080
	source.ProxyUser = "proxy-user"
	source.ProxyPass = "proxy-pass"
	source.HostKeyAction = "verify"
	source.HostKeyFingerprint = "SHA256:test"
	source.TrustScope = strings.Repeat("b", 32)
	source.Sftp = newEditorTestSFTPClient(t)

	cloned := cloneSFTPClientConfig(source)
	if cloned.Username != source.Username || cloned.Password != source.Password || cloned.Hostname != source.Hostname || cloned.Port != source.Port || cloned.LoginType != source.LoginType {
		t.Fatalf("clone lost direct SSH configuration: %#v", cloned)
	}
	if cloned.PrivateKey != source.PrivateKey || cloned.Passphrase != source.Passphrase || cloned.ProxyHost != source.ProxyHost || cloned.ProxyPort != source.ProxyPort || cloned.ProxyUser != source.ProxyUser || cloned.ProxyPass != source.ProxyPass {
		t.Fatalf("clone lost key or proxy configuration: %#v", cloned)
	}
	if cloned.HostKeyAction != source.HostKeyAction || cloned.HostKeyFingerprint != source.HostKeyFingerprint || cloned.TrustScope != source.TrustScope {
		t.Fatalf("clone lost trust configuration: %#v", cloned)
	}
	if cloned.Client != nil || cloned.Sftp != nil || cloned.Session != nil || cloned.StdinPipe != nil {
		t.Fatalf("clone retained runtime transports: %#v", cloned)
	}

	// Closing the source must not consume the cloned client's fresh closeOnce.
	source.Close()
	cloned.Sftp = newEditorTestSFTPClient(t)
	cloned.Close()
	if _, err := cloned.Sftp.Getwd(); err == nil {
		t.Fatal("cloned client did not close its independently-created SFTP transport")
	}
}

func TestCloseSFTPSessionForcesReconnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resetSFTPSessionRegistryForTest()
	t.Cleanup(resetSFTPSessionRegistryForTest)
	oldFactory := createSFTPSessionClient
	t.Cleanup(func() { createSFTPSessionClient = oldFactory })
	var creates atomic.Int32
	createSFTPSessionClient = func(client core.SSHClient) (*core.SSHClient, error) {
		creates.Add(1)
		client.Sftp = newEditorTestSFTPClient(t)
		return &client, nil
	}
	sshInfo := sftpSessionTestSSHInfo(t)
	path := editorTestRemotePath(t.TempDir())
	if response := callFileListForSessionTest(t, sshInfo, "session-close-123", path); response.Msg != "success" {
		t.Fatal(response.Msg)
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/session/close", strings.NewReader(`{"sessionId":"session-close-123"}`))
	ctx.Request.RemoteAddr = "198.51.100.20:43210"
	ctx.Request.Header.Set("Content-Type", "application/json")
	if response := CloseSFTPSession(ctx); response.Msg != "success" {
		t.Fatalf("CloseSFTPSession() = %q", response.Msg)
	}
	if response := callFileListForSessionTest(t, sshInfo, "session-close-123", path); response.Msg != "success" {
		t.Fatal(response.Msg)
	}
	if got := creates.Load(); got != 2 {
		t.Fatalf("SFTP client creations after close = %d, want 2", got)
	}
}

func TestCancelledPersistentSFTPSessionIsDiscarded(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resetSFTPSessionRegistryForTest()
	t.Cleanup(resetSFTPSessionRegistryForTest)
	oldFactory := createSFTPSessionClient
	t.Cleanup(func() { createSFTPSessionClient = oldFactory })
	createSFTPSessionClient = func(client core.SSHClient) (*core.SSHClient, error) {
		client.Sftp = newEditorTestSFTPClient(t)
		return &client, nil
	}

	requestContext, cancel := context.WithCancel(context.Background())
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/list", nil).WithContext(requestContext)
	ctx.Request.RemoteAddr = "198.51.100.20:43210"
	decoded, err := core.DecodedMsgToSSHClient(sftpSessionTestSSHInfo(t))
	if err != nil {
		t.Fatal(err)
	}
	lease, err := acquireSFTPSessionLease(ctx, "session-cancel-123", sftpSessionTestSSHInfo(t), decoded)
	if err != nil {
		t.Fatal(err)
	}
	client := lease.Client
	cancel()
	lease.Release(false)

	sftpSessionRegistry.Lock()
	remaining := len(sftpSessionRegistry.entries)
	sftpSessionRegistry.Unlock()
	if remaining != 0 {
		t.Fatalf("cancelled SFTP session entries = %d, want 0", remaining)
	}
	if _, err := client.Sftp.Getwd(); err == nil {
		t.Fatal("cancelled persistent SFTP transport remained open")
	}
}

func TestNormalizeSFTPSessionID(t *testing.T) {
	for _, valid := range []string{"session-123", "550e8400-e29b-41d4-a716-446655440000", "tab_1.example"} {
		if got, err := normalizeSFTPSessionID(valid); err != nil || got != valid {
			t.Fatalf("normalizeSFTPSessionID(%q) = %q, %v", valid, got, err)
		}
	}
	for _, invalid := range []string{"bad/id", "bad id", strings.Repeat("x", maxSFTPSessionIDLength+1)} {
		if _, err := normalizeSFTPSessionID(invalid); err == nil {
			t.Fatalf("normalizeSFTPSessionID(%q) unexpectedly succeeded", invalid)
		}
	}
}

func TestExpireSFTPSessionEntryReplacesExistingIdleTimer(t *testing.T) {
	entry := &sftpSessionEntry{lastUsed: time.Now()}
	oldTimer := time.AfterFunc(time.Hour, func() {})
	entry.idleTimer = oldTimer
	expireSFTPSessionEntry(entry)
	if oldTimer.Stop() {
		t.Fatal("expireSFTPSessionEntry left the previous idle timer active")
	}
	entry.opMu.Lock()
	newTimer := entry.idleTimer
	entry.closed = true
	entry.idleTimer = nil
	entry.opMu.Unlock()
	if newTimer == nil {
		t.Fatal("expireSFTPSessionEntry did not schedule the remaining idle period")
	}
	newTimer.Stop()
}
