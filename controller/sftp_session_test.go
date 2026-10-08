package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

type sftpSessionWaitTestContext struct {
	context.Context
	waiting chan struct{}
	cancel  context.CancelFunc
	once    sync.Once
}

func (ctx *sftpSessionWaitTestContext) Done() <-chan struct{} {
	ctx.once.Do(func() {
		if ctx.waiting != nil {
			close(ctx.waiting)
		}
		if ctx.cancel != nil {
			ctx.cancel()
		}
	})
	return ctx.Context.Done()
}

func assertEmptySFTPSessionRegistry(test *testing.T) {
	test.Helper()
	sftpSessionRegistry.Lock()
	defer sftpSessionRegistry.Unlock()
	if len(sftpSessionRegistry.entries) != 0 || len(sftpSessionRegistry.clients) != 0 {
		test.Fatalf("SFTP quota leaked: entries=%d clients=%v", len(sftpSessionRegistry.entries), sftpSessionRegistry.clients)
	}
}

func TestSFTPSessionLeaseWaitHonorsCancellation(test *testing.T) {
	for _, mode := range []string{"cancel", "deadline"} {
		test.Run(mode, func(test *testing.T) {
			resetSFTPSessionRegistryForTest()
			test.Cleanup(resetSFTPSessionRegistryForTest)
			originalFactory := createSFTPSessionClient
			test.Cleanup(func() { createSFTPSessionClient = originalFactory })
			var creates atomic.Int32
			createSFTPSessionClient = func(configuration core.SSHClient) (*core.SSHClient, error) {
				creates.Add(1)
				return &configuration, nil
			}
			sshInfo := sftpSessionTestSSHInfo(test)
			configuration, err := core.DecodedMsgToSSHClient(sshInfo)
			if err != nil {
				test.Fatal(err)
			}
			requestContext, _ := memorySFTPTestRequest(test, "/file/list", nil)
			first, err := acquireSFTPSessionLease(requestContext, "queued-session", sshInfo, configuration)
			if err != nil || !first.isPersistent {
				test.Fatalf("first lease = %v, %v", first, err)
			}
			test.Cleanup(func() { first.Release(true) })
			var waitContext context.Context
			var cancel context.CancelFunc
			if mode == "deadline" {
				waitContext, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			} else {
				waitContext, cancel = context.WithCancel(context.Background())
			}
			waiting := make(chan struct{})
			observed := &sftpSessionWaitTestContext{Context: waitContext, waiting: waiting}
			secondContext, _ := memorySFTPTestRequest(test, "/file/list", nil)
			secondContext.Request = secondContext.Request.WithContext(observed)
			result := make(chan error, 1)
			finished := make(chan struct{})
			test.Cleanup(func() {
				cancel()
				first.Release(true)
				select {
				case <-finished:
				case <-time.After(memorySFTPTestTimeout):
					test.Error("SFTP waiter did not exit")
				}
			})
			go func() {
				defer close(finished)
				lease, acquireErr := acquireSFTPSessionLease(secondContext, "queued-session", sshInfo, configuration)
				if lease != nil {
					lease.Release(true)
				}
				result <- acquireErr
			}()
			select {
			case <-waiting:
			case <-time.After(memorySFTPTestTimeout):
				test.Fatal("second request did not enter the session lock wait")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case acquireErr := <-result:
				if !errors.Is(acquireErr, waitContext.Err()) || acquireErr == nil {
					test.Fatalf("cancelled lock wait returned %v, want %v", acquireErr, waitContext.Err())
				}
			case <-time.After(memorySFTPTestTimeout):
				test.Fatal("cancelled SFTP request stayed queued behind the active lease")
			}
			sftpSessionRegistry.Lock()
			remaining := len(sftpSessionRegistry.entries)
			clientQuota := sftpSessionRegistry.clients[first.entry.clientID]
			sftpSessionRegistry.Unlock()
			if remaining != 1 || clientQuota != 1 || first.entry.closed {
				test.Fatalf("waiter cancellation damaged the active session: entries=%d quota=%d", remaining, clientQuota)
			}
			first.Release(false)
			retryContext, stopRetry := context.WithTimeout(context.Background(), memorySFTPTestTimeout)
			defer stopRetry()
			requestContext.Request = requestContext.Request.WithContext(retryContext)
			retry, err := acquireSFTPSessionLease(requestContext, "queued-session", sshInfo, configuration)
			if err != nil {
				test.Fatalf("session lock leaked after waiter cancellation: %v", err)
			}
			retry.Release(true)
			if creates.Load() != 1 {
				test.Fatalf("waiter cancellation reconnected the active session: creates=%d", creates.Load())
			}
			assertEmptySFTPSessionRegistry(test)
		})
	}
}

func TestSFTPSessionCancelledRequestDoesNotReserveQuota(test *testing.T) {
	resetSFTPSessionRegistryForTest()
	test.Cleanup(resetSFTPSessionRegistryForTest)
	originalFactory := createSFTPSessionClient
	test.Cleanup(func() { createSFTPSessionClient = originalFactory })
	creates := 0
	createSFTPSessionClient = func(configuration core.SSHClient) (*core.SSHClient, error) {
		creates++
		return &configuration, nil
	}
	for _, sessionID := range []string{"", "cancelled-session"} {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		requestContext, _ := memorySFTPTestRequest(test, "/file/list", nil)
		requestContext.Request = requestContext.Request.WithContext(ctx)
		lease, err := acquireSFTPSessionLease(requestContext, sessionID, "memory", core.NewSSHClient())
		if lease != nil || !errors.Is(err, context.Canceled) {
			if lease != nil {
				lease.Release(true)
			}
			test.Fatalf("cancelled request acquired a lease: %v, %v", lease, err)
		}
	}
	if creates != 0 {
		test.Fatalf("cancelled requests created %d connections", creates)
	}
	assertEmptySFTPSessionRegistry(test)
}

func TestSFTPSessionCancellationAfterRegistrationReleasesQuota(test *testing.T) {
	resetSFTPSessionRegistryForTest()
	test.Cleanup(resetSFTPSessionRegistryForTest)
	originalFactory := createSFTPSessionClient
	test.Cleanup(func() { createSFTPSessionClient = originalFactory })
	creates := 0
	createSFTPSessionClient = func(configuration core.SSHClient) (*core.SSHClient, error) {
		creates++
		return &configuration, nil
	}
	for attempt := 0; attempt < 32; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		requestContext, _ := memorySFTPTestRequest(test, "/file/list", nil)
		requestContext.Request = requestContext.Request.WithContext(&sftpSessionWaitTestContext{Context: ctx, cancel: cancel})
		lease, err := acquireSFTPSessionLease(requestContext, "cancel-at-lock", "memory", core.NewSSHClient())
		cancel()
		if lease != nil || !errors.Is(err, context.Canceled) {
			if lease != nil {
				lease.Release(true)
			}
			test.Fatalf("registration cancellation = %v, %v", lease, err)
		}
		assertEmptySFTPSessionRegistry(test)
	}
	if creates != 0 {
		test.Fatalf("cancelled empty sessions created %d connections", creates)
	}
}

func TestSFTPSessionCancellationDuringCreationReleasesQuota(test *testing.T) {
	for _, sessionID := range []string{"", "cancel-during-create"} {
		test.Run("session="+sessionID, func(test *testing.T) {
			resetSFTPSessionRegistryForTest()
			test.Cleanup(resetSFTPSessionRegistryForTest)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			originalFactory := createSFTPSessionClient
			test.Cleanup(func() { createSFTPSessionClient = originalFactory })
			var created *core.SSHClient
			createSFTPSessionClient = func(configuration core.SSHClient) (*core.SSHClient, error) {
				created = &configuration
				cancel()
				return created, nil
			}
			requestContext, _ := memorySFTPTestRequest(test, "/file/list", nil)
			requestContext.Request = requestContext.Request.WithContext(ctx)
			configuration := core.NewSSHClient()
			configuration.Password = "secret"
			lease, err := acquireSFTPSessionLease(requestContext, sessionID, "memory", configuration)
			if lease != nil || !errors.Is(err, context.Canceled) {
				if lease != nil {
					lease.Release(true)
				}
				test.Fatalf("creation cancellation = %v, %v", lease, err)
			}
			if created == nil || created.Password != "" {
				test.Fatal("cancelled connection retained credentials")
			}
			assertEmptySFTPSessionRegistry(test)
		})
	}
}

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
