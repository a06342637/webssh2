package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/pkg/sftp"
)

func TestNativeArchiveDownloadFormBinding(t *testing.T) {
	for _, body := range []string{"jobId=test-id", "jobId=one&jobId=two", "jobId=one&unknown=two"} {
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = httptest.NewRequest(http.MethodPost, "/file/archive/download", strings.NewReader(body))
		ctx.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		var request folderArchiveJobRequest
		err := bindFolderArchiveDownloadRequest(ctx, &request)
		if body == "jobId=test-id" {
			if err != nil || request.JobID != "test-id" {
				t.Fatalf("native form: %s %v", request.JobID, err)
			}
		} else if err == nil {
			t.Fatal("invalid form accepted")
		}
	}
}

func TestFolderCreateListRenameDeleteAndLinks(t *testing.T) {
	handlers := sftp.InMemHandler()
	installMemorySFTPFileFactories(t, handlers)
	client, _ := newMemorySFTPTestClient(t, handlers)
	if err := client.MkdirAll("/work"); err != nil {
		t.Fatal(err)
	}
	request := folderRequest{SSHInfo: sftpSessionTestSSHInfo(t), Path: "/work", Name: " folder "}
	ctx, _ := memorySFTPTestRequest(t, "/file/mkdir", request)
	if response := CreateFolder(ctx); response.Msg != "success" {
		t.Fatal(response.Msg)
	}
	ctx, _ = memorySFTPTestRequest(t, "/file/mkdir", request)
	if response := CreateFolder(ctx); ResponseHTTPStatus(response) != 409 {
		t.Fatal(response.Msg)
	}
	if entries, err := client.ReadDir("/work"); err != nil || len(entries) != 1 || entries[0].Name() != " folder " {
		t.Fatalf("list: %v %v", entries, err)
	}
	writeMemorySFTPTestFile(t, client, "/work/ folder /nested/file.txt", "inside")
	writeMemorySFTPTestFile(t, client, "/outside/keep.txt", "outside")
	if err := client.Symlink("/outside", "/work/ folder /link"); err != nil {
		t.Fatal(err)
	}
	ctx, _ = memorySFTPTestRequest(t, "/file/rename", fileRenameRequest{SSHInfo: request.SSHInfo, Path: "/work/ folder ", NewName: "renamed"})
	if response := RenameFile(ctx); response.Msg != "success" {
		t.Fatal(response.Msg)
	}
	request.Path, request.Confirmed = "/work/renamed", true
	ctx, _ = memorySFTPTestRequest(t, "/file/rmdir", request)
	if response := DeleteFolder(ctx); response.Msg != "success" {
		t.Fatal(response.Msg)
	}
	if _, err := client.Stat(request.Path); !os.IsNotExist(err) {
		t.Fatal("folder was not deleted")
	}
	if got := readMemorySFTPTestFile(t, client, "/outside/keep.txt"); got != "outside" {
		t.Fatal("followed directory symlink")
	}
}

func TestFolderDeletionRequiresConfirmationAndRejectsRoot(t *testing.T) {
	for _, request := range []folderRequest{
		{Path: "/", Confirmed: true}, {Path: "/tmp/..", Confirmed: true}, {Path: "relative", Confirmed: true}, {Path: "/work"},
	} {
		ctx, _ := memorySFTPTestRequest(t, "/file/rmdir", request)
		if response := DeleteFolder(ctx); ResponseHTTPStatus(response) != 400 {
			t.Fatalf("%+v: %s", request, response.Msg)
		}
	}
	client, _ := newMemorySFTPTestClient(t, sftp.InMemHandler())
	writeMemorySFTPTestFile(t, client, "/work/nested/file", "keep")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	remaining := 100
	if err := removeRemoteTree(ctx, client, "/work", 0, &remaining); err == nil {
		t.Fatal("ignored cancellation")
	}
	if got := readMemorySFTPTestFile(t, client, "/work/nested/file"); got != "keep" {
		t.Fatal(got)
	}
}
