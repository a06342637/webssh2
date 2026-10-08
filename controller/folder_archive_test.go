package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const memoryFolderArchiveTestPath = "/tmp/.webssh-folder-0123456789abcdef01234567.tar.gz"

type folderArchiveTestReader func(request *sftp.Request) (io.ReaderAt, error)

func (reader folderArchiveTestReader) Fileread(request *sftp.Request) (io.ReaderAt, error) {
	return reader(request)
}

type folderArchiveBlockedTestReader struct {
	entered chan struct{}
	closed  <-chan struct{}
	once    sync.Once
}

func (reader *folderArchiveBlockedTestReader) ReadAt(buffer []byte, offset int64) (int, error) {
	reader.once.Do(func() { close(reader.entered) })
	<-reader.closed
	return 0, context.Canceled
}

func TestFolderArchiveCleanupDialCancelsStalledSFTPSetup(test *testing.T) {
	test.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		test.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		test.Fatal(err)
	}
	serverConfig := &ssh.ServerConfig{NoClientAuth: true}
	serverConfig.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		test.Fatal(err)
	}
	entered := make(chan struct{})
	accepted := make(chan net.Conn, 1)
	serverDone := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), memorySFTPTestTimeout)
	test.Cleanup(func() {
		cancel()
		_ = listener.Close()
		select {
		case connection := <-accepted:
			_ = connection.Close()
		default:
		}
	})
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		accepted <- connection
		defer connection.Close()
		transport, channels, requests, handshakeErr := ssh.NewServerConn(connection, serverConfig)
		if handshakeErr != nil {
			serverDone <- handshakeErr
			return
		}
		defer transport.Close()
		go ssh.DiscardRequests(requests)
		newChannel, open := <-channels
		if !open {
			serverDone <- errors.New("cleanup SSH transport closed before SFTP setup")
			return
		}
		channel, channelRequests, channelErr := newChannel.Accept()
		if channelErr != nil {
			serverDone <- channelErr
			return
		}
		defer channel.Close()
		for request := range channelRequests {
			if request.Type == "subsystem" {
				close(entered)
			}
		}
		serverDone <- nil
	}()
	configuration := core.NewSSHClient()
	configuration.Username = "memory"
	configuration.Hostname = "127.0.0.1"
	configuration.Port = listener.Addr().(*net.TCPAddr).Port
	result := make(chan error, 1)
	go func() {
		client, dialErr := dialFolderArchiveCleanupClient(ctx, configuration)
		if client != nil {
			client.Close()
		}
		result <- dialErr
	}()
	select {
	case <-entered:
	case <-time.After(memorySFTPTestTimeout):
		test.Fatal("cleanup connection did not enter SFTP negotiation")
	}
	cancel()
	select {
	case dialErr := <-result:
		if !errors.Is(dialErr, context.Canceled) {
			test.Fatalf("cancelled cleanup dial = %v", dialErr)
		}
	case <-time.After(time.Second):
		test.Fatal("cleanup dial ignored cancellation during SFTP negotiation")
	}
	select {
	case serverErr := <-serverDone:
		if serverErr != nil {
			test.Fatal(serverErr)
		}
	case <-time.After(time.Second):
		test.Fatal("cancelled cleanup dial retained its SSH transport")
	}
}

func TestFolderArchivePreservesSourceWhitespaceAndCleansDownloadedArchive(test *testing.T) {
	handlers := sftp.InMemHandler()
	inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
	writeMemorySFTPTestFile(test, inspectionClient, "/srv/project/report.txt", "wrong directory")
	writeMemorySFTPTestFile(test, inspectionClient, "/srv/project /report.txt", "requested directory")
	if err := inspectionClient.MkdirAll("/tmp"); err != nil {
		test.Fatal(err)
	}
	client, _ := newMemorySFTPTestClient(test, handlers)
	originalFactory := createFileSFTPClient
	test.Cleanup(func() { createFileSFTPClient = originalFactory })
	createFileSFTPClient = func(ctx context.Context, configuration *core.SSHClient) error {
		configuration.Sftp = client
		return nil
	}
	originalCleanupFactory := createFolderArchiveCleanupClient
	test.Cleanup(func() { createFolderArchiveCleanupClient = originalCleanupFactory })
	createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
		return nil, errors.New("healthy archive download must reuse its cleanup transport")
	}
	jobID := testFolderArchiveID(test)
	requestContext, recorder := memorySFTPTestRequest(test, "/file/archive/prepare", folderArchivePrepareRequest{
		SSHInfo: sftpSessionTestSSHInfo(test), Path: "/srv/project ", JobID: jobID,
	})
	PrepareDirectoryArchive(requestContext)
	if recorder.Code != http.StatusAccepted {
		test.Fatalf("prepare status=%d body=%s", recorder.Code, recorder.Body)
	}
	job := findFolderArchiveJob(strings.Repeat("a", 32), jobID)
	if job == nil {
		test.Fatal("prepared archive job was not stored")
	}
	test.Cleanup(func() {
		cancelFolderArchiveJob(job)
		select {
		case <-job.workDone:
		case <-time.After(memorySFTPTestTimeout):
			test.Error("archive worker did not finish")
		}
		job.cleanupResources()
		deleteFolderArchiveJob(job)
	})
	select {
	case <-job.workDone:
	case <-time.After(memorySFTPTestTimeout):
		test.Fatal("archive worker did not finish")
	}
	if snapshot := job.snapshot(); snapshot["status"] != "ready" || snapshot["path"] != "/srv/project " || snapshot["name"] != "project .tar.gz" {
		test.Fatalf("prepared archive changed its source path: %#v", snapshot)
	}
	archivePath := job.archivePath
	requestContext, recorder = memorySFTPTestRequest(test, "/file/archive/download", folderArchiveJobRequest{JobID: jobID})
	DownloadPreparedDirectoryArchive(requestContext)
	if recorder.Code != http.StatusOK {
		test.Fatalf("archive download status=%d", recorder.Code)
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil {
		test.Fatal(err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	found := false
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			test.Fatal(err)
		}
		if header.Name == "project /report.txt" {
			content, err := io.ReadAll(tarReader)
			if err != nil || string(content) != "requested directory" {
				test.Fatalf("archive content=%q error=%v", content, err)
			}
			found = true
		}
	}
	if !found {
		test.Fatal("archive omitted the whitespace-preserving directory")
	}
	if _, err := inspectionClient.Lstat(archivePath); !os.IsNotExist(err) {
		test.Fatalf("downloaded archive remained on the server: %v", err)
	}
	if job.archivePath != "" || findFolderArchiveJob(strings.Repeat("a", 32), jobID) != nil {
		test.Fatal("downloaded archive retained its job resources")
	}
}

func TestFolderArchiveDownloadCancellationCleansTemporaryFile(test *testing.T) {
	for _, phase := range []string{"open", "read"} {
		test.Run(phase, func(test *testing.T) {
			handlers := sftp.InMemHandler()
			inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
			writeMemorySFTPTestFile(test, inspectionClient, memoryFolderArchiveTestPath, "archive")
			entered := make(chan struct{})
			var connectionClosed <-chan struct{}
			activeHandlers := handlers
			activeHandlers.FileGet = folderArchiveTestReader(func(request *sftp.Request) (io.ReaderAt, error) {
				if phase == "open" {
					close(entered)
					<-connectionClosed
					return nil, context.Canceled
				}
				return &folderArchiveBlockedTestReader{entered: entered, closed: connectionClosed}, nil
			})
			client, closed := newMemorySFTPTestClient(test, activeHandlers)
			connectionClosed = closed
			sshClient := memoryFolderArchiveTestClient(client)
			cleanupSFTP, _ := newMemorySFTPTestClient(test, handlers)
			originalFactory := createFolderArchiveCleanupClient
			test.Cleanup(func() { createFolderArchiveCleanupClient = originalFactory })
			createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
				configuration.Sftp = cleanupSFTP
				return &configuration, nil
			}
			jobCtx, cancelJob := context.WithCancel(context.Background())
			workDone := make(chan struct{})
			close(workDone)
			releases := 0
			job := &folderArchiveJob{
				id: testFolderArchiveID(test), owner: strings.Repeat("a", 32), status: "ready",
				ctx: jobCtx, cancel: cancelJob, client: sshClient, workDone: workDone,
				archivePath: memoryFolderArchiveTestPath, archiveSize: int64(len("archive")), downloadName: "folder.tar.gz",
				release: func() { releases++ },
			}
			job.stopIOCancel = closeSSHOnContextDone(jobCtx, sshClient)
			if result := storeFolderArchiveJob(job); result != folderArchiveStoreOK {
				test.Fatalf("store archive job = %v", result)
			}
			ctx, cancel := context.WithCancel(context.Background())
			requestContext, _ := memorySFTPTestRequest(test, "/file/archive/download", folderArchiveJobRequest{JobID: job.id})
			requestContext.Request = requestContext.Request.WithContext(ctx)
			finished := make(chan struct{})
			test.Cleanup(func() {
				cancel()
				cancelJob()
				select {
				case <-finished:
				case <-time.After(memorySFTPTestTimeout):
					test.Error("cancelled archive download did not stop")
				}
				job.cleanupResources()
				deleteFolderArchiveJob(job)
			})
			go func() {
				defer close(finished)
				DownloadPreparedDirectoryArchive(requestContext)
			}()
			select {
			case <-entered:
			case <-time.After(memorySFTPTestTimeout):
				test.Fatal("archive download did not enter the stalled operation")
			}
			cancel()
			select {
			case <-finished:
			case <-time.After(memorySFTPTestTimeout):
				test.Fatal("request cancellation did not stop archive download and cleanup")
			}
			if _, err := inspectionClient.Lstat(memoryFolderArchiveTestPath); !os.IsNotExist(err) {
				test.Fatalf("cancelled archive download left its temporary file: %v", err)
			}
			if releases != 1 || job.status != "cancelled" || job.client != nil {
				test.Fatalf("cancelled archive resources: releases=%d status=%s", releases, job.status)
			}
			assertArchiveCredentialsCleared(test, sshClient)
		})
	}
}

func memoryFolderArchiveTestClient(client *sftp.Client) *core.SSHClient {
	configuration := core.NewSSHClient()
	configuration.Sftp = client
	configuration.Hostname = "memory.invalid"
	configuration.Username = "archive-test"
	configuration.Password = "password"
	configuration.PrivateKey = "private-key"
	configuration.Passphrase = "passphrase"
	configuration.ProxyPass = "proxy-password"
	configuration.TrustScope = strings.Repeat("a", 32)
	return &configuration
}

func assertArchiveCredentialsCleared(test *testing.T, client *core.SSHClient) {
	test.Helper()
	if client == nil || client.Password != "" || client.PrivateKey != "" || client.Passphrase != "" || client.ProxyPass != "" {
		test.Fatal("archive cleanup retained SSH credentials")
	}
}

func TestFolderArchiveCancellationReconnectsAndRemovesTemporaryFile(test *testing.T) {
	handlers := sftp.InMemHandler()
	inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
	writeMemorySFTPTestFile(test, inspectionClient, memoryFolderArchiveTestPath, "archive")
	client, connectionClosed := newMemorySFTPTestClient(test, handlers)
	sshClient := memoryFolderArchiveTestClient(client)
	cleanupSFTP, cleanupClosed := newMemorySFTPTestClient(test, handlers)
	originalFactory := createFolderArchiveCleanupClient
	test.Cleanup(func() { createFolderArchiveCleanupClient = originalFactory })
	var cleanupClient *core.SSHClient
	creates := 0
	createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
		creates++
		if ctx.Err() != nil {
			test.Fatal("archive cleanup inherited the cancelled job context")
		}
		if _, bounded := ctx.Deadline(); !bounded {
			test.Fatal("archive cleanup reconnect has no deadline")
		}
		if configuration.Password != "password" || configuration.PrivateKey != "private-key" || configuration.Passphrase != "passphrase" || configuration.ProxyPass != "proxy-password" || configuration.TrustScope != sshClient.TrustScope {
			test.Fatal("archive cleanup lost its scoped connection configuration")
		}
		if configuration.Client != nil || configuration.Sftp != nil {
			test.Fatal("archive cleanup copied a closed transport")
		}
		configuration.Sftp = cleanupSFTP
		cleanupClient = &configuration
		return cleanupClient, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	releases := 0
	job := &folderArchiveJob{
		ctx: ctx, cancel: cancel, status: "compressing", client: sshClient,
		archivePath: memoryFolderArchiveTestPath, workDone: make(chan struct{}),
		release: func() { releases++ },
	}
	job.stopIOCancel = closeSSHOnContextDone(ctx, sshClient)
	test.Cleanup(job.cleanupResources)
	cancelFolderArchiveJob(job)
	select {
	case <-connectionClosed:
	case <-time.After(memorySFTPTestTimeout):
		test.Fatal("archive cancellation did not close the active SFTP transport")
	}
	close(job.workDone)
	job.cleanupResources()
	job.cleanupResources()
	cancelFolderArchiveJob(job)
	if _, err := inspectionClient.Lstat(memoryFolderArchiveTestPath); !os.IsNotExist(err) {
		test.Fatalf("cancelled archive remains after reconnect cleanup: %v", err)
	}
	if creates != 1 || releases != 1 || job.archivePath != "" || job.client != nil || job.release != nil {
		test.Fatalf("archive cleanup was not idempotent: reconnects=%d releases=%d path=%q", creates, releases, job.archivePath)
	}
	assertArchiveCredentialsCleared(test, sshClient)
	assertArchiveCredentialsCleared(test, cleanupClient)
	select {
	case <-cleanupClosed:
	default:
		test.Fatal("archive cleanup retained its reconnected transport")
	}
}

func TestFolderArchiveCancellationRetainsFailedArchiveForCleanup(test *testing.T) {
	for _, phase := range []string{"open", "reserve", "write", "verify"} {
		test.Run(phase, func(test *testing.T) {
			handlers := sftp.InMemHandler()
			inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
			if err := inspectionClient.MkdirAll("/tmp"); err != nil {
				test.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var connectionClosed <-chan struct{}
			interrupt := func() error {
				cancel()
				<-connectionClosed
				return context.Canceled
			}
			activeHandlers := handlers
			activeHandlers.FileCmd = memorySFTPTestCommands{FileCmder: handlers.FileCmd, before: func(request *sftp.Request) error {
				if phase == "reserve" && request.Method == "Setstat" {
					return interrupt()
				}
				return nil
			}}
			activeHandlers.FilePut = memorySFTPTestWriter{FileWriter: handlers.FilePut, before: func(request *sftp.Request) error {
				if phase == "open" && request.Pflags().Excl {
					if _, err := handlers.FilePut.Filewrite(request); err != nil {
						return err
					}
					return interrupt()
				}
				if phase == "write" && request.Pflags().Trunc {
					return interrupt()
				}
				return nil
			}}
			activeHandlers.FileList = memorySFTPTestLister{FileLister: handlers.FileList, before: func(method, remotePath string) error {
				if phase == "verify" && method == "Lstat" {
					return interrupt()
				}
				return nil
			}}
			client, closed := newMemorySFTPTestClient(test, activeHandlers)
			connectionClosed = closed
			sshClient := memoryFolderArchiveTestClient(client)
			cleanupSFTP, _ := newMemorySFTPTestClient(test, handlers)
			originalFactory := createFolderArchiveCleanupClient
			test.Cleanup(func() { createFolderArchiveCleanupClient = originalFactory })
			createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
				configuration.Sftp = cleanupSFTP
				return &configuration, nil
			}
			job := &folderArchiveJob{ctx: ctx, cancel: cancel, client: sshClient}
			job.stopIOCancel = closeSSHOnContextDone(ctx, sshClient)
			test.Cleanup(job.cleanupResources)
			if _, _, err := prepareRemoteArchiveManifest(job, "/srv/source ", remoteArchiveManifest{}); err == nil {
				test.Fatal("cancelled archive preparation succeeded")
			}
			archivePath := job.archivePath
			if archivePath == "" {
				test.Fatal("failed archive preparation forgot the reserved remote path")
			}
			if _, err := inspectionClient.Lstat(archivePath); err != nil {
				test.Fatalf("test did not leave a reserved remote archive: %v", err)
			}
			job.cleanupResources()
			if _, err := inspectionClient.Lstat(archivePath); !os.IsNotExist(err) {
				test.Fatalf("partial archive remains after cancellation: %v", err)
			}
			assertArchiveCredentialsCleared(test, sshClient)
		})
	}
}

func TestFolderArchiveCleanupHonorsDeadline(test *testing.T) {
	for _, phase := range []string{"active-remove", "reconnect", "reconnected-remove"} {
		test.Run(phase, func(test *testing.T) {
			handlers := sftp.InMemHandler()
			inspectionClient, _ := newMemorySFTPTestClient(test, handlers)
			writeMemorySFTPTestFile(test, inspectionClient, memoryFolderArchiveTestPath, "archive")
			var blockedConnectionClosed <-chan struct{}
			blockingHandlers := handlers
			blockingHandlers.FileCmd = memorySFTPTestCommands{FileCmder: handlers.FileCmd, before: func(request *sftp.Request) error {
				if request.Method == "Remove" {
					<-blockedConnectionClosed
					return context.DeadlineExceeded
				}
				return nil
			}}
			blockedClient, closed := newMemorySFTPTestClient(test, blockingHandlers)
			blockedConnectionClosed = closed
			client, _ := newMemorySFTPTestClient(test, handlers)
			sshClient := memoryFolderArchiveTestClient(client)
			if phase == "active-remove" {
				sshClient.Sftp = blockedClient
			} else {
				sshClient.Close()
			}
			originalFactory := createFolderArchiveCleanupClient
			test.Cleanup(func() { createFolderArchiveCleanupClient = originalFactory })
			var cleanupClient *core.SSHClient
			createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
				if phase == "reconnect" {
					<-ctx.Done()
					return nil, ctx.Err()
				}
				configuration.Sftp = blockedClient
				cleanupClient = &configuration
				return cleanupClient, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			started := time.Now()
			err := cleanupRemoteFolderArchive(ctx, sshClient, memoryFolderArchiveTestPath)
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
				test.Fatalf("cleanup was not bounded: error=%v duration=%s", err, time.Since(started))
			}
			if phase != "reconnect" {
				select {
				case <-closed:
				default:
					test.Fatal("cleanup deadline did not close the stalled SFTP transport")
				}
			}
			if cleanupClient != nil {
				assertArchiveCredentialsCleared(test, cleanupClient)
			}
		})
	}
}

func TestFolderArchiveFailedCleanupReleasesCredentialsAndQuota(test *testing.T) {
	handlers := sftp.InMemHandler()
	client, _ := newMemorySFTPTestClient(test, handlers)
	sshClient := memoryFolderArchiveTestClient(client)
	sshClient.Close()
	originalFactory := createFolderArchiveCleanupClient
	test.Cleanup(func() { createFolderArchiveCleanupClient = originalFactory })
	var failedClient *core.SSHClient
	createFolderArchiveCleanupClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
		failedClient = &configuration
		return failedClient, errors.New("cleanup connection unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	releases := 0
	job := &folderArchiveJob{ctx: ctx, cancel: cancel, client: sshClient, archivePath: memoryFolderArchiveTestPath, release: func() { releases++ }}
	job.cleanupResources()
	job.cleanupResources()
	if releases != 1 || job.client != nil || job.cancel != nil || job.archivePath != memoryFolderArchiveTestPath {
		test.Fatal("failed cleanup leaked quota or discarded the unresolved archive path")
	}
	assertArchiveCredentialsCleared(test, sshClient)
	assertArchiveCredentialsCleared(test, failedClient)
}

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
