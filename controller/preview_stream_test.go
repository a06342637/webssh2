package controller

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

func TestAuthorizeFilePreviewCancellationInterruptsMetadata(test *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, blockedMethod := range []string{"Lstat", "Readlink"} {
		test.Run(blockedMethod, func(test *testing.T) {
			resetPreviewGrantsForTest(test)
			handlers := sftp.InMemHandler()
			inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
			writeMemorySFTPTestFile(test, inspectionClient, "/srv/image.png ", "preview")
			requestedPath := "/srv/image.png "
			if blockedMethod == "Readlink" {
				requestedPath = "/srv/link.png "
				if err := inspectionClient.Symlink("image.png ", requestedPath); err != nil {
					test.Fatal(err)
				}
			}
			entered := make(chan struct{})
			var connectionClosed <-chan struct{}
			blockingHandlers := handlers
			blockingHandlers.FileList = memorySFTPTestLister{FileLister: handlers.FileList, before: func(method, remotePath string) error {
				if method == blockedMethod {
					close(entered)
					<-connectionClosed
					return context.Canceled
				}
				return nil
			}}
			client, closed := newMemorySFTPTestClient(test, blockingHandlers)
			connectionClosed = closed
			originalFactory := createPreviewSFTPClient
			test.Cleanup(func() { createPreviewSFTPClient = originalFactory })
			createPreviewSFTPClient = func(ctx context.Context, configuration *core.SSHClient) error {
				configuration.Sftp = client
				return nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			requestContext, _ := memorySFTPTestRequest(test, "/file/preview/authorize", fileRequest{SSHInfo: sftpSessionTestSSHInfo(test), Path: requestedPath})
			requestContext.Request = requestContext.Request.WithContext(ctx)
			response := make(chan *ResponseBody, 1)
			finished := make(chan struct{})
			test.Cleanup(func() {
				cancel()
				_ = client.Close()
				select {
				case <-finished:
				case <-time.After(memorySFTPTestTimeout):
					test.Error("preview authorization did not finish")
				}
			})
			go func() {
				defer close(finished)
				response <- AuthorizeFilePreview(requestContext)
			}()
			select {
			case <-entered:
			case <-time.After(memorySFTPTestTimeout):
				test.Fatal("preview did not enter the blocked metadata operation")
			}
			cancel()
			select {
			case result := <-response:
				if result.Msg == "success" || result.Data != nil {
					test.Fatalf("cancelled preview was authorized: %#v", result)
				}
			case <-time.After(memorySFTPTestTimeout):
				test.Fatalf("request cancellation did not interrupt SFTP %s", blockedMethod)
			}
			select {
			case <-closed:
			default:
				test.Fatal("cancelled preview retained its transport")
			}
			previewGrants.Lock()
			count := len(previewGrants.items)
			previewGrants.Unlock()
			if count != 0 {
				test.Fatalf("cancelled preview retained %d grants", count)
			}
		})
	}
}

func TestAuthorizeFilePreviewPreservesRemotePathWhitespace(test *testing.T) {
	resetPreviewGrantsForTest(test)
	handlers := sftp.InMemHandler()
	inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
	writeMemorySFTPTestFile(test, inspectionClient, "/srv/image.png", "wrong")
	writeMemorySFTPTestFile(test, inspectionClient, "/srv/image.png ", "requested preview")
	if err := inspectionClient.Symlink("image.png ", "/srv/link.png "); err != nil {
		test.Fatal(err)
	}
	originalFactory := createPreviewSFTPClient
	test.Cleanup(func() { createPreviewSFTPClient = originalFactory })
	createPreviewSFTPClient = func(ctx context.Context, configuration *core.SSHClient) error {
		configuration.Sftp, _ = newMemorySFTPTestClient(test, handlers)
		return nil
	}
	requestContext, _ := memorySFTPTestRequest(test, "/file/preview/authorize", fileRequest{
		SSHInfo: sftpSessionTestSSHInfo(test), Path: "/srv/link.png ",
	})
	response := AuthorizeFilePreview(requestContext)
	if response.Msg != "success" {
		test.Fatal(response.Msg)
	}
	token := response.Data.(gin.H)["token"].(string)
	previewGrants.Lock()
	grant := previewGrants.items[token]
	previewGrants.Unlock()
	if grant == nil || grant.path != "/srv/link.png " || grant.targetPath != "/srv/image.png " || grant.size != int64(len("requested preview")) {
		test.Fatal("preview authorization changed the requested or resolved POSIX path")
	}
}

func resetPreviewGrantsForTest(t *testing.T) {
	t.Helper()
	previewGrants.Lock()
	original := previewGrants.items
	previewGrants.items = make(map[string]*previewGrant)
	previewGrants.Unlock()
	t.Cleanup(func() {
		expireAllPreviewGrants()
		previewGrants.Lock()
		previewGrants.items = original
		previewGrants.Unlock()
	})
}

func testPreviewGrant(owner, token, remotePath string) *previewGrant {
	client := core.NewSSHClient()
	client.Username = "root"
	client.Password = "secret"
	client.Hostname = "example.test"
	return &previewGrant{
		token: token, owner: owner, client: client, path: remotePath,
		expiresAt: time.Now().Add(time.Hour),
	}
}

func TestParsePreviewRange(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		size       int64
		start      int64
		end        int64
		partial    bool
		shouldFail bool
	}{
		{name: "whole file", size: 100, start: 0, end: 99},
		{name: "bounded", raw: "bytes=10-19", size: 100, start: 10, end: 19, partial: true},
		{name: "open ended", raw: "bytes=90-", size: 100, start: 90, end: 99, partial: true},
		{name: "suffix", raw: "bytes=-10", size: 100, start: 90, end: 99, partial: true},
		{name: "suffix clamps", raw: "bytes=-200", size: 100, start: 0, end: 99, partial: true},
		{name: "outside", raw: "bytes=100-", size: 100, shouldFail: true},
		{name: "multiple", raw: "bytes=0-1,4-5", size: 100, shouldFail: true},
		{name: "empty ranged file", raw: "bytes=0-", size: 0, shouldFail: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			start, end, partial, err := parsePreviewRange(test.raw, test.size)
			if test.shouldFail {
				if err == nil {
					t.Fatalf("parsePreviewRange(%q, %d) unexpectedly succeeded", test.raw, test.size)
				}
				return
			}
			if err != nil || start != test.start || end != test.end || partial != test.partial {
				t.Fatalf("parsePreviewRange(%q, %d) = (%d, %d, %v, %v)", test.raw, test.size, start, end, partial, err)
			}
		})
	}
}

func TestPreviewGrantReplacesInactiveGrantForSamePath(t *testing.T) {
	resetPreviewGrantsForTest(t)
	first := testPreviewGrant("owner", strings.Repeat("a", 48), "/tmp/image.png")
	second := testPreviewGrant("owner", strings.Repeat("b", 48), "/tmp/image.png")
	if !storePreviewGrant(first) || !storePreviewGrant(second) {
		t.Fatal("preview grant replacement was rejected")
	}
	if first.client.Password != "" || !first.expired {
		t.Fatal("replaced preview grant retained credentials")
	}
	previewGrants.Lock()
	count := len(previewGrants.items)
	stored := previewGrants.items[second.token]
	previewGrants.Unlock()
	if count != 1 || stored != second {
		t.Fatalf("preview grant map contains %d entries after replacement", count)
	}
}

func TestPreviewGrantPerOwnerLimit(t *testing.T) {
	resetPreviewGrantsForTest(t)
	for i := 0; i < previewGrantMaxPerOwner; i++ {
		grant := testPreviewGrant("owner", fmt.Sprintf("%048x", i+1), fmt.Sprintf("/tmp/%d.png", i))
		if !storePreviewGrant(grant) {
			t.Fatalf("grant %d was rejected before the per-owner limit", i)
		}
	}
	overflow := testPreviewGrant("owner", strings.Repeat("f", 48), "/tmp/overflow.png")
	if storePreviewGrant(overflow) {
		t.Fatal("preview grant beyond the per-owner limit was accepted")
	}
	scrubPreviewGrant(overflow)
}

func TestPreviewGrantConfigSizeLimit(t *testing.T) {
	client := core.NewSSHClient()
	client.PrivateKey = strings.Repeat("k", previewGrantMaxConfigSize+1)
	if previewGrantConfigSize(client) <= previewGrantMaxConfigSize {
		t.Fatal("oversized preview SSH configuration was not detected")
	}
}

func TestPreviewGrantRevocationIsOwnerBoundAndScrubsCredentials(t *testing.T) {
	resetPreviewGrantsForTest(t)
	token := strings.Repeat("c", 48)
	grant := testPreviewGrant("owner", token, "/tmp/revoke.png")
	if !storePreviewGrant(grant) {
		t.Fatal("preview grant was not stored")
	}
	if revokePreviewGrant("different-owner", token) {
		t.Fatal("a different owner revoked the preview grant")
	}
	if grant.client.Password == "" {
		t.Fatal("owner mismatch scrubbed a live preview grant")
	}
	if !revokePreviewGrant("owner", token) {
		t.Fatal("preview grant owner could not revoke the grant")
	}
	if grant.client.Password != "" || !grant.expired {
		t.Fatal("revoked inactive preview grant retained credentials")
	}
}

func TestActivePreviewGrantScrubsAfterRelease(t *testing.T) {
	resetPreviewGrantsForTest(t)
	token := strings.Repeat("d", 48)
	grant := testPreviewGrant("owner", token, "/tmp/active.png")
	if !storePreviewGrant(grant) {
		t.Fatal("preview grant was not stored")
	}
	claimed, release, err := claimPreviewGrant("owner", token)
	if err != nil || claimed != grant {
		t.Fatalf("claimPreviewGrant() = %#v, %v", claimed, err)
	}
	if !revokePreviewGrant("owner", token) {
		t.Fatal("active preview grant could not be revoked")
	}
	if grant.client.Password == "" {
		t.Fatal("active preview credentials were scrubbed before the stream released them")
	}
	release()
	if grant.client.Password != "" {
		t.Fatal("revoked preview credentials remained after the active stream released them")
	}
}
