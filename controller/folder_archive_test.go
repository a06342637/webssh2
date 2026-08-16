package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func testFolderArchiveID(t *testing.T) string {
	t.Helper()
	id, err := newFolderArchiveJobID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func clearFolderArchiveTestState(job *folderArchiveJob) {
	if job != nil {
		deleteFolderArchiveJob(job)
	}
}

func TestFolderArchiveJobIDValidation(t *testing.T) {
	valid := []string{
		"0123456789abcdef0123456789abcdef",
		"01234567-89ab-cdef-0123-456789abcdef",
		"0123456789abcdef0123456789abcdef0123",
	}
	for _, id := range valid {
		if !validFolderArchiveJobID(id) {
			t.Fatalf("valid job id was rejected: %q", id)
		}
	}
	invalid := []string{"", "short", "0123456789abcdef0123456789abcdeg", "01234567-89ab-cdef-0123"}
	for _, id := range invalid {
		if validFolderArchiveJobID(id) {
			t.Fatalf("invalid job id was accepted: %q", id)
		}
	}
}

func TestFolderArchiveLimitsAreCapped(t *testing.T) {
	t.Setenv("WEBSSH_FOLDER_ARCHIVE_MAX_ENTRIES", "999999999")
	if got := folderArchiveMaxEntries(); got != 200000 {
		t.Fatalf("folder archive entry cap = %d, want 200000", got)
	}
	t.Setenv("WEBSSH_FOLDER_ARCHIVE_MAX_BYTES", "9223372036854775807")
	if got := folderArchiveMaxBytes(); got != int64(20<<30) {
		t.Fatalf("invalid folder archive byte limit = %d, want default", got)
	}
}

func TestFolderArchiveCancellationBeforePreparePreventsJobCreation(t *testing.T) {
	owner := "owner-before-prepare"
	id := testFolderArchiveID(t)
	key := folderArchiveCancellationKey(owner, id)
	defer func() {
		folderArchiveJobs.Lock()
		delete(folderArchiveJobs.cancellations, key)
		folderArchiveJobs.Unlock()
	}()

	if job, accepted := cancelOrRememberFolderArchiveJob(owner, id); job != nil || !accepted {
		t.Fatal("cancelling an unknown job unexpectedly returned a live job")
	}
	job := &folderArchiveJob{id: id, owner: owner}
	if got := storeFolderArchiveJob(job); got != folderArchiveStoreCancelled {
		t.Fatalf("store result = %v, want cancelled", got)
	}
	if found := findFolderArchiveJob(owner, id); found != nil {
		t.Fatal("cancelled-before-prepare job was stored")
	}
}

func TestStoreFolderArchiveJobNeverOverwritesAnExistingID(t *testing.T) {
	id := testFolderArchiveID(t)
	first := &folderArchiveJob{id: id, owner: "first"}
	second := &folderArchiveJob{id: id, owner: "second"}
	defer clearFolderArchiveTestState(first)
	defer clearFolderArchiveTestState(second)

	if got := storeFolderArchiveJob(first); got != folderArchiveStoreOK {
		t.Fatalf("first store result = %v", got)
	}
	if got := storeFolderArchiveJob(second); got != folderArchiveStoreConflict {
		t.Fatalf("second store result = %v, want conflict", got)
	}
	if got := findFolderArchiveJob(first.owner, id); got != first {
		t.Fatal("existing job was replaced")
	}
}

func TestFolderArchiveCancellationIsOwnerScoped(t *testing.T) {
	id := testFolderArchiveID(t)
	ctx, cancel := context.WithCancel(context.Background())
	job := &folderArchiveJob{id: id, owner: "owner-a", status: "compressing", ctx: ctx, cancel: cancel}
	otherKey := folderArchiveCancellationKey("owner-b", id)
	defer func() {
		cancel()
		clearFolderArchiveTestState(job)
		folderArchiveJobs.Lock()
		delete(folderArchiveJobs.cancellations, otherKey)
		folderArchiveJobs.Unlock()
	}()
	if got := storeFolderArchiveJob(job); got != folderArchiveStoreOK {
		t.Fatalf("store result = %v", got)
	}
	if found, accepted := cancelOrRememberFolderArchiveJob("owner-b", id); found != nil || !accepted {
		t.Fatalf("other owner cancellation = job %v accepted %v", found, accepted)
	}
	if ctx.Err() != nil || findFolderArchiveJob("owner-a", id) != job {
		t.Fatal("another owner cancelled or removed the live archive job")
	}
}

func TestFolderArchiveReadyCannotReviveACancelledJob(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	job := &folderArchiveJob{ctx: ctx, cancel: cancel, status: "cancelled", totalBytes: 10, totalEntries: 2}
	cancel()
	if job.markReady("/tmp/archive.tar.gz", 5) {
		t.Fatal("cancelled job was marked ready")
	}
	if job.status != "cancelled" || job.readyTimer != nil {
		t.Fatalf("cancelled job changed state: status=%q timer=%v", job.status, job.readyTimer)
	}
}

func TestFolderArchiveCancellationInterruptsSSHBeforeWorkerFinishes(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	sshClient := &core.SSHClient{Sftp: client}
	job := &folderArchiveJob{
		ctx:      ctx,
		cancel:   cancel,
		status:   "compressing",
		client:   sshClient,
		workDone: make(chan struct{}),
	}
	job.stopIOCancel = closeSSHOnContextDone(ctx, sshClient)
	t.Cleanup(job.cleanupResources)

	cancelFolderArchiveJob(job)
	if job.workFinished() {
		t.Fatal("test worker unexpectedly finished")
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := client.Getwd(); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelling the job did not close the SFTP transport")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFolderArchiveCancellationIsSafeAfterCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	workDone := make(chan struct{})
	close(workDone)
	job := &folderArchiveJob{
		ctx:      ctx,
		cancel:   cancel,
		status:   "ready",
		workDone: workDone,
	}
	job.cleanupResources()
	// Ready timers, explicit cancellation and shutdown can converge on the same
	// job. Repeated cancellation must remain idempotent after cleanup.
	cancelFolderArchiveJob(job)
	cancelFolderArchiveJob(job)
	if job.status != "cancelled" {
		t.Fatalf("job status after cancellation = %q", job.status)
	}
}

func TestFolderArchiveSnapshotReportsActualCompressionProgress(t *testing.T) {
	job := &folderArchiveJob{status: "compressing", totalBytes: 1000, processedBytes: 437, totalEntries: 10, processedEntries: 4}
	if got := job.snapshot()["percent"]; got != 43 {
		t.Fatalf("byte progress = %v, want 43", got)
	}
	job.processedBytes = 1000
	if got := job.snapshot()["percent"]; got != 99 {
		t.Fatalf("compressing progress = %v, want capped 99", got)
	}
	job.totalBytes = 0
	job.processedBytes = 0
	job.processedEntries = 5
	if got := job.snapshot()["percent"]; got != 50 {
		t.Fatalf("entry progress = %v, want 50", got)
	}
	job.status = "ready"
	if got := job.snapshot()["percent"]; got != 100 {
		t.Fatalf("ready progress = %v, want 100", got)
	}
}

func TestFolderArchiveManifestTracksAndWritesNestedContent(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	root := t.TempDir()
	sourceLocalPath := root + string(os.PathSeparator) + "project"
	nestedLocalPath := sourceLocalPath + string(os.PathSeparator) + "nested"
	if err := os.MkdirAll(nestedLocalPath, 0o755); err != nil {
		t.Fatal(err)
	}
	firstContent := []byte("hello folder archive\n")
	secondContent := []byte("配置=true\n")
	if err := os.WriteFile(sourceLocalPath+string(os.PathSeparator)+"README.txt", firstContent, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedLocalPath+string(os.PathSeparator)+"配置.ini", secondContent, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedLocalPath+string(os.PathSeparator)+"empty.txt", nil, 0o600); err != nil {
		t.Fatal(err)
	}

	var lastScanEntries, lastScanBytes int64
	manifest, err := scanRemoteArchiveManifest(context.Background(), client, editorTestRemotePath(sourceLocalPath), "project", func(entries, size int64, _ string) {
		if entries < lastScanEntries || size < lastScanBytes {
			t.Fatalf("scan progress moved backwards: entries %d -> %d, bytes %d -> %d", lastScanEntries, entries, lastScanBytes, size)
		}
		lastScanEntries, lastScanBytes = entries, size
	})
	if err != nil {
		t.Fatal(err)
	}
	wantBytes := int64(len(firstContent) + len(secondContent))
	if manifest.TotalBytes != wantBytes || lastScanBytes != wantBytes || lastScanEntries != int64(len(manifest.Entries)) {
		t.Fatalf("manifest totals = bytes %d/%d entries %d/%d", manifest.TotalBytes, wantBytes, lastScanEntries, len(manifest.Entries))
	}

	archivePath, err := reserveRemoteFolderArchive(client, editorTestRemotePath(root))
	if err != nil {
		t.Fatal(err)
	}
	defer removeRemoteFolderArchive(client, archivePath)
	var lastBytes, lastEntries int64
	if err := writeRemoteArchiveManifest(context.Background(), client, archivePath, manifest, func(processedBytes, processedEntries int64, _ string) {
		if processedBytes < lastBytes || processedEntries < lastEntries {
			t.Fatalf("compression progress moved backwards: entries %d -> %d, bytes %d -> %d", lastEntries, processedEntries, lastBytes, processedBytes)
		}
		lastBytes, lastEntries = processedBytes, processedEntries
	}); err != nil {
		t.Fatal(err)
	}
	if lastBytes != manifest.TotalBytes || lastEntries != int64(len(manifest.Entries)) {
		t.Fatalf("final compression progress = bytes %d/%d entries %d/%d", lastBytes, manifest.TotalBytes, lastEntries, len(manifest.Entries))
	}

	archiveFile, err := os.Open(cleanEditorTestPath(archivePath))
	if err != nil {
		t.Fatal(err)
	}
	defer archiveFile.Close()
	gzipReader, err := gzip.NewReader(archiveFile)
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	contents := make(map[string][]byte)
	for {
		header, nextErr := tarReader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			continue
		}
		content, readErr := io.ReadAll(tarReader)
		if readErr != nil {
			t.Fatal(readErr)
		}
		contents[header.Name] = content
	}
	if !bytes.Equal(contents["project/README.txt"], firstContent) || !bytes.Equal(contents["project/nested/配置.ini"], secondContent) {
		t.Fatalf("unexpected archive content: %#v", contents)
	}
	if content, exists := contents["project/nested/empty.txt"]; !exists || len(content) != 0 {
		t.Fatal("empty file was not preserved")
	}
}

func TestDownloadPreparedDirectoryArchiveStreamsThenCleansUp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := newEditorTestSFTPClient(t)
	root := t.TempDir()
	archivePath, err := reserveRemoteFolderArchive(client, editorTestRemotePath(root))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("prepared archive payload")
	archiveFile, err := client.OpenFile(archivePath, os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := archiveFile.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}

	owner := "0123456789abcdef0123456789abcdef"
	ctx, cancel := context.WithCancel(context.Background())
	releases := 0
	sshClient := &core.SSHClient{Sftp: client, Password: "secret", PrivateKey: "key", Passphrase: "phrase", ProxyPass: "proxy"}
	workDone := make(chan struct{})
	close(workDone)
	job := &folderArchiveJob{
		id:           testFolderArchiveID(t),
		owner:        owner,
		status:       "ready",
		archivePath:  archivePath,
		archiveSize:  int64(len(payload)),
		downloadName: "project.tar.gz",
		ctx:          ctx,
		cancel:       cancel,
		client:       sshClient,
		release:      func() { releases++ },
		workDone:     workDone,
	}
	defer cancel()
	defer clearFolderArchiveTestState(job)
	if got := storeFolderArchiveJob(job); got != folderArchiveStoreOK {
		t.Fatalf("store result = %v", got)
	}

	body, err := json.Marshal(folderArchiveJobRequest{JobID: job.id})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Set(trustScopeContextKey, owner)
	ginContext.Request = httptest.NewRequest(http.MethodPost, "/file/archive/download", strings.NewReader(string(body)))
	ginContext.Request.Header.Set("Content-Type", "application/json")

	DownloadPreparedDirectoryArchive(ginContext)

	if recorder.Code != http.StatusOK || !bytes.Equal(recorder.Body.Bytes(), payload) {
		t.Fatalf("download response = status %d body %q", recorder.Code, recorder.Body.Bytes())
	}
	if got := recorder.Header().Get("X-WebSSH-Download-Kind"); got != "directory-archive" {
		t.Fatalf("download kind = %q", got)
	}
	if found := findFolderArchiveJob(owner, job.id); found != nil {
		t.Fatal("completed download job remained in the job table")
	}
	if _, err := os.Lstat(cleanEditorTestPath(archivePath)); !os.IsNotExist(err) {
		t.Fatalf("temporary archive remained after download: %v", err)
	}
	if releases != 1 {
		t.Fatalf("SSH slot release count = %d", releases)
	}
	if sshClient.Password != "" || sshClient.PrivateKey != "" || sshClient.Passphrase != "" || sshClient.ProxyPass != "" {
		t.Fatal("SSH credentials were not cleared after archive download")
	}
}
