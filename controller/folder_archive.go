package controller

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	pathpkg "path"
	"strconv"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

const (
	folderArchiveJobMaxCount  = 1024
	folderArchiveJobMaxRun    = 2 * time.Hour
	folderArchiveJobReadyTTL  = 10 * time.Minute
	folderArchiveJobResultTTL = 2 * time.Minute
	folderArchiveCancelTTL    = 2 * time.Minute
	folderArchiveCancelMax    = folderArchiveJobMaxCount * 4
)

type folderArchivePrepareRequest struct {
	SSHInfo string `json:"sshInfo"`
	Path    string `json:"path"`
	JobID   string `json:"jobId,omitempty"`
}

type folderArchiveJobRequest struct {
	JobID string `json:"jobId"`
}

type remoteArchiveManifestEntry struct {
	RemotePath  string
	ArchiveName string
	LinkTarget  string
	Info        os.FileInfo
}

type remoteArchiveManifest struct {
	Entries    []remoteArchiveManifestEntry
	TotalBytes int64
}

type folderArchiveJob struct {
	mu sync.Mutex

	id               string
	owner            string
	requestedPath    string
	downloadName     string
	archivePath      string
	archiveSize      int64
	status           string
	currentPath      string
	errorMessage     string
	totalBytes       int64
	processedBytes   int64
	totalEntries     int64
	processedEntries int64
	createdAt        time.Time
	updatedAt        time.Time

	ctx          context.Context
	cancel       context.CancelFunc
	client       *core.SSHClient
	release      func()
	stopIOCancel func()
	workDone     chan struct{}
	cleanupOnce  sync.Once
	runtimeTimer *time.Timer
	readyTimer   *time.Timer
}

var folderArchiveJobs = struct {
	sync.RWMutex
	items         map[string]*folderArchiveJob
	cancellations map[string]time.Time
}{items: make(map[string]*folderArchiveJob), cancellations: make(map[string]time.Time)}

type folderArchiveStoreResult int

const (
	folderArchiveStoreOK folderArchiveStoreResult = iota
	folderArchiveStoreFull
	folderArchiveStoreConflict
	folderArchiveStoreCancelled
)

func folderArchiveMaxEntries() int {
	return envPositiveInt("WEBSSH_FOLDER_ARCHIVE_MAX_ENTRIES", 500000)
}

func newFolderArchiveJobID() (string, error) {
	random := make([]byte, 18)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

func validFolderArchiveJobID(id string) bool {
	compact := strings.ReplaceAll(strings.TrimSpace(id), "-", "")
	if len(compact) != 32 && len(compact) != 36 {
		return false
	}
	decoded, err := hex.DecodeString(compact)
	return err == nil && len(decoded) >= 16
}

func folderArchiveOwner(c *gin.Context) (string, error) {
	return requestTrustScope(c)
}

func folderArchiveCancellationKey(owner, id string) string {
	return owner + "\x00" + id
}

func pruneFolderArchiveCancellationsLocked(now time.Time) {
	for key, expiresAt := range folderArchiveJobs.cancellations {
		if !expiresAt.After(now) {
			delete(folderArchiveJobs.cancellations, key)
		}
	}
}

func storeFolderArchiveJob(job *folderArchiveJob) folderArchiveStoreResult {
	folderArchiveJobs.Lock()
	defer folderArchiveJobs.Unlock()
	now := time.Now()
	pruneFolderArchiveCancellationsLocked(now)
	cancellationKey := folderArchiveCancellationKey(job.owner, job.id)
	if expiresAt, cancelled := folderArchiveJobs.cancellations[cancellationKey]; cancelled && expiresAt.After(now) {
		delete(folderArchiveJobs.cancellations, cancellationKey)
		return folderArchiveStoreCancelled
	}
	if len(folderArchiveJobs.items) >= folderArchiveJobMaxCount {
		return folderArchiveStoreFull
	}
	if _, exists := folderArchiveJobs.items[job.id]; exists {
		return folderArchiveStoreConflict
	}
	folderArchiveJobs.items[job.id] = job
	return folderArchiveStoreOK
}

func cancelOrRememberFolderArchiveJob(owner, id string) (*folderArchiveJob, bool) {
	now := time.Now()
	key := folderArchiveCancellationKey(owner, id)
	folderArchiveJobs.Lock()
	pruneFolderArchiveCancellationsLocked(now)
	job := folderArchiveJobs.items[id]
	if job != nil && job.owner == owner {
		folderArchiveJobs.Unlock()
		return job, true
	}
	if len(folderArchiveJobs.cancellations) >= folderArchiveCancelMax {
		folderArchiveJobs.Unlock()
		return nil, false
	}
	expiresAt := now.Add(folderArchiveCancelTTL)
	folderArchiveJobs.cancellations[key] = expiresAt
	folderArchiveJobs.Unlock()
	time.AfterFunc(folderArchiveCancelTTL, func() {
		folderArchiveJobs.Lock()
		if current, exists := folderArchiveJobs.cancellations[key]; exists && current.Equal(expiresAt) {
			delete(folderArchiveJobs.cancellations, key)
		}
		folderArchiveJobs.Unlock()
	})
	return nil, true
}

func deleteFolderArchiveJob(job *folderArchiveJob) {
	if job == nil {
		return
	}
	folderArchiveJobs.Lock()
	if folderArchiveJobs.items[job.id] == job {
		delete(folderArchiveJobs.items, job.id)
	}
	folderArchiveJobs.Unlock()
}

func findFolderArchiveJob(owner, id string) *folderArchiveJob {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	folderArchiveJobs.RLock()
	job := folderArchiveJobs.items[id]
	folderArchiveJobs.RUnlock()
	if job == nil || job.owner != owner {
		return nil
	}
	return job
}

func scheduleFolderArchiveJobRemoval(job *folderArchiveJob, delay time.Duration) {
	if delay <= 0 {
		deleteFolderArchiveJob(job)
		return
	}
	time.AfterFunc(delay, func() { deleteFolderArchiveJob(job) })
}

func (job *folderArchiveJob) setStatus(status, currentPath string) {
	job.mu.Lock()
	job.status = status
	job.currentPath = currentPath
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) updateScan(entries, bytes int64, currentPath string) {
	job.mu.Lock()
	job.status = "scanning"
	job.totalEntries = entries
	job.totalBytes = bytes
	job.currentPath = currentPath
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) beginCompression(totalBytes, totalEntries int64, currentPath string) {
	job.mu.Lock()
	job.status = "compressing"
	job.totalBytes = totalBytes
	job.processedBytes = 0
	job.totalEntries = totalEntries
	job.processedEntries = 0
	job.currentPath = currentPath
	job.errorMessage = ""
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) setArchivePath(archivePath string) {
	job.mu.Lock()
	job.archivePath = archivePath
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) clearArchivePath(archivePath string) {
	job.mu.Lock()
	if job.archivePath == archivePath {
		job.archivePath = ""
	}
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) markReady(archivePath string, archiveSize int64) bool {
	job.mu.Lock()
	if job.ctx.Err() != nil || job.status == "cancelled" {
		job.mu.Unlock()
		return false
	}
	job.status = "ready"
	job.archivePath = archivePath
	job.archiveSize = archiveSize
	job.processedBytes = job.totalBytes
	job.processedEntries = job.totalEntries
	job.currentPath = ""
	job.updatedAt = time.Now()
	job.readyTimer = time.AfterFunc(folderArchiveJobReadyTTL, func() { cancelFolderArchiveJob(job) })
	job.mu.Unlock()
	return true
}

func (job *folderArchiveJob) markTerminal(status string, err error) {
	job.mu.Lock()
	job.status = status
	if err != nil {
		job.errorMessage = err.Error()
	}
	job.currentPath = ""
	job.updatedAt = time.Now()
	job.mu.Unlock()
}

func (job *folderArchiveJob) workFinished() bool {
	select {
	case <-job.workDone:
		return true
	default:
		return false
	}
}

func (job *folderArchiveJob) cleanupResources() {
	job.cleanupOnce.Do(func() {
		job.mu.Lock()
		client := job.client
		archivePath := job.archivePath
		release := job.release
		stopIOCancel := job.stopIOCancel
		job.client = nil
		job.release = nil
		job.stopIOCancel = nil
		if job.runtimeTimer != nil {
			job.runtimeTimer.Stop()
			job.runtimeTimer = nil
		}
		if job.readyTimer != nil {
			job.readyTimer.Stop()
			job.readyTimer = nil
		}
		job.mu.Unlock()

		if stopIOCancel != nil {
			stopIOCancel()
		}
		if client != nil {
			if client.Sftp != nil && archivePath != "" {
				if err := removeRemoteFolderArchive(client.Sftp, archivePath); err != nil {
					log.Printf("could not remove prepared folder archive %q: %v", archivePath, err)
				}
			}
			client.Close()
			client.Password = ""
			client.PrivateKey = ""
			client.Passphrase = ""
			client.ProxyPass = ""
		}
		if release != nil {
			release()
		}
	})
}

func (job *folderArchiveJob) snapshot() gin.H {
	job.mu.Lock()
	defer job.mu.Unlock()
	percent := 0
	switch job.status {
	case "compressing":
		if job.totalBytes > 0 {
			percent = int(job.processedBytes * 100 / job.totalBytes)
		} else if job.totalEntries > 0 {
			percent = int(job.processedEntries * 100 / job.totalEntries)
		}
		if percent > 99 {
			percent = 99
		}
	case "finalizing":
		percent = 99
	case "ready", "downloading", "completed":
		percent = 100
	}
	return gin.H{
		"jobId":            job.id,
		"status":           job.status,
		"name":             job.downloadName,
		"path":             job.requestedPath,
		"currentPath":      job.currentPath,
		"totalBytes":       job.totalBytes,
		"processedBytes":   job.processedBytes,
		"totalEntries":     job.totalEntries,
		"processedEntries": job.processedEntries,
		"archiveSize":      job.archiveSize,
		"percent":          percent,
		"error":            job.errorMessage,
	}
}

func scanRemoteArchiveManifest(ctx context.Context, client *sftp.Client, sourcePath, archiveRootName string, progress func(entries, bytes int64, currentPath string)) (remoteArchiveManifest, error) {
	manifest := remoteArchiveManifest{Entries: make([]remoteArchiveManifestEntry, 0, 128)}
	maxEntries := folderArchiveMaxEntries()
	var visit func(remotePath, archiveName string, info os.FileInfo, depth int) error
	visit = func(remotePath, archiveName string, info os.FileInfo, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > 256 {
			return fmt.Errorf("folder nesting is too deep near %s", remotePath)
		}
		if len(manifest.Entries) >= maxEntries {
			return fmt.Errorf("folder contains more than %d entries", maxEntries)
		}
		entry := remoteArchiveManifestEntry{RemotePath: remotePath, ArchiveName: archiveName, Info: info}
		if info.Mode()&os.ModeSymlink != 0 {
			linkTarget, err := client.ReadLink(remotePath)
			if err != nil {
				return fmt.Errorf("read symbolic link %s: %w", remotePath, err)
			}
			entry.LinkTarget = linkTarget
		}
		manifest.Entries = append(manifest.Entries, entry)
		if info.Mode().IsRegular() && info.Size() > 0 {
			if manifest.TotalBytes > int64(^uint64(0)>>1)-info.Size() {
				return fmt.Errorf("folder is too large to measure safely")
			}
			manifest.TotalBytes += info.Size()
		}
		if progress != nil {
			progress(int64(len(manifest.Entries)), manifest.TotalBytes, remotePath)
		}
		if !info.IsDir() {
			return nil
		}
		children, err := client.ReadDir(remotePath)
		if err != nil {
			return fmt.Errorf("read directory %s: %w", remotePath, err)
		}
		for _, child := range children {
			name := child.Name()
			if !validRemoteArchiveChildName(name) {
				return fmt.Errorf("invalid filename in remote directory %s", remotePath)
			}
			if isRemoteFolderArchiveName(name) {
				continue
			}
			childPath := pathpkg.Join(remotePath, name)
			childInfo, err := client.Lstat(childPath)
			if err != nil {
				return fmt.Errorf("inspect %s: %w", childPath, err)
			}
			if err := visit(childPath, pathpkg.Join(strings.TrimSuffix(archiveName, "/"), name), childInfo, depth+1); err != nil {
				return err
			}
		}
		return nil
	}

	rootInfo, err := client.Lstat(sourcePath)
	if err != nil {
		return manifest, err
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return manifest, fmt.Errorf("remote archive source is no longer a directory")
	}
	if err := visit(sourcePath, archiveRootName, rootInfo, 0); err != nil {
		return manifest, err
	}
	return manifest, nil
}

type folderArchiveProgressReader struct {
	ctx        context.Context
	reader     io.Reader
	onProgress func(int64)
}

func (reader *folderArchiveProgressReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	count, err := reader.reader.Read(buffer)
	if count > 0 && reader.onProgress != nil {
		reader.onProgress(int64(count))
	}
	return count, err
}

func writeRemoteArchiveManifest(ctx context.Context, client *sftp.Client, archivePath string, manifest remoteArchiveManifest, progress func(bytes, entries int64, currentPath string)) error {
	archiveFile, err := client.OpenFile(archivePath, os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		return err
	}
	gzipWriter := gzip.NewWriter(requestContextWriter{ctx: ctx, w: archiveFile})
	tarWriter := tar.NewWriter(gzipWriter)
	var processedBytes, processedEntries int64
	resultErr := error(nil)
	buffer := make([]byte, 256<<10)

	for _, entry := range manifest.Entries {
		if err := ctx.Err(); err != nil {
			resultErr = err
			break
		}
		header, err := tar.FileInfoHeader(entry.Info, entry.LinkTarget)
		if err != nil {
			resultErr = fmt.Errorf("archive metadata %s: %w", entry.RemotePath, err)
			break
		}
		header.Name = entry.ArchiveName
		header.Format = tar.FormatPAX
		if entry.Info.IsDir() && !strings.HasSuffix(header.Name, "/") {
			header.Name += "/"
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			resultErr = fmt.Errorf("write archive header %s: %w", entry.RemotePath, err)
			break
		}
		if entry.Info.Mode().IsRegular() {
			file, err := client.Open(entry.RemotePath)
			if err != nil {
				resultErr = fmt.Errorf("open %s: %w", entry.RemotePath, err)
				break
			}
			reader := &folderArchiveProgressReader{ctx: ctx, reader: file, onProgress: func(count int64) {
				processedBytes += count
				if progress != nil {
					progress(processedBytes, processedEntries, entry.RemotePath)
				}
			}}
			copied, copyErr := io.CopyBuffer(tarWriter, io.LimitReader(reader, entry.Info.Size()), buffer)
			closeErr := file.Close()
			if copyErr == nil && copied != entry.Info.Size() {
				copyErr = io.ErrUnexpectedEOF
			}
			if copyErr != nil {
				resultErr = fmt.Errorf("archive %s: %w", entry.RemotePath, copyErr)
				break
			}
			if closeErr != nil {
				resultErr = fmt.Errorf("close %s: %w", entry.RemotePath, closeErr)
				break
			}
		}
		processedEntries++
		if progress != nil {
			progress(processedBytes, processedEntries, entry.RemotePath)
		}
	}

	if err := tarWriter.Close(); resultErr == nil && err != nil {
		resultErr = err
	}
	if err := gzipWriter.Close(); resultErr == nil && err != nil {
		resultErr = err
	}
	if err := archiveFile.Close(); resultErr == nil && err != nil {
		resultErr = err
	}
	return resultErr
}

func prepareRemoteArchiveManifest(job *folderArchiveJob, sourcePath string, manifest remoteArchiveManifest) (string, os.FileInfo, error) {
	var failures []string
	for _, directory := range remoteFolderArchiveCandidateDirs(sourcePath) {
		if err := job.ctx.Err(); err != nil {
			return "", nil, err
		}
		archivePath, err := reserveRemoteFolderArchive(job.client.Sftp, directory)
		if err != nil {
			failures = append(failures, directory+": "+err.Error())
			continue
		}
		job.setArchivePath(archivePath)
		job.beginCompression(manifest.TotalBytes, int64(len(manifest.Entries)), sourcePath)
		err = writeRemoteArchiveManifest(job.ctx, job.client.Sftp, archivePath, manifest, func(bytes, entries int64, currentPath string) {
			job.mu.Lock()
			job.processedBytes = bytes
			job.processedEntries = entries
			job.currentPath = currentPath
			job.updatedAt = time.Now()
			job.mu.Unlock()
		})
		if err != nil {
			_ = removeRemoteFolderArchive(job.client.Sftp, archivePath)
			job.clearArchivePath(archivePath)
			if ctxErr := job.ctx.Err(); ctxErr != nil {
				return "", nil, ctxErr
			}
			failures = append(failures, directory+": "+err.Error())
			continue
		}
		job.setStatus("finalizing", "")
		info, err := job.client.Sftp.Lstat(archivePath)
		if err != nil {
			_ = removeRemoteFolderArchive(job.client.Sftp, archivePath)
			job.clearArchivePath(archivePath)
			failures = append(failures, directory+": verify archive: "+err.Error())
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() <= 0 {
			_ = removeRemoteFolderArchive(job.client.Sftp, archivePath)
			job.clearArchivePath(archivePath)
			failures = append(failures, directory+": remote archive is empty or invalid")
			continue
		}
		return archivePath, info, nil
	}
	if len(failures) == 0 {
		return "", nil, fmt.Errorf("could not create the remote folder archive")
	}
	return "", nil, fmt.Errorf("could not create the remote folder archive: %s", strings.Join(failures, "; "))
}

func finishFolderArchiveWorker(job *folderArchiveJob, err error) {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || job.ctx.Err() != nil {
		job.markTerminal("cancelled", nil)
	} else {
		job.markTerminal("error", err)
	}
	job.cleanupResources()
	scheduleFolderArchiveJobRemoval(job, folderArchiveJobResultTTL)
}

func runFolderArchiveJob(job *folderArchiveJob) {
	defer func() {
		close(job.workDone)
		job.mu.Lock()
		cancelled := job.status == "cancelled"
		job.mu.Unlock()
		if cancelled {
			job.cleanupResources()
			scheduleFolderArchiveJobRemoval(job, folderArchiveJobResultTTL)
		}
	}()
	if err := job.ctx.Err(); err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	job.setStatus("connecting", "")
	if err := job.client.CreateSftp(); err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	if err := job.ctx.Err(); err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	info, resolvedPath, err := statRemoteTarget(job.client.Sftp, job.requestedPath)
	if err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	if !info.IsDir() {
		finishFolderArchiveWorker(job, fmt.Errorf("the selected folder changed before it could be archived"))
		return
	}
	if resolvedPath == "/" {
		finishFolderArchiveWorker(job, fmt.Errorf("the remote root directory cannot be archived"))
		return
	}
	archiveRootName := pathpkg.Base(pathpkg.Clean(job.requestedPath))
	if archiveRootName == "." || archiveRootName == "/" || archiveRootName == "" {
		archiveRootName = "folder"
	}
	job.setStatus("scanning", resolvedPath)
	manifest, err := scanRemoteArchiveManifest(job.ctx, job.client.Sftp, resolvedPath, archiveRootName, job.updateScan)
	if err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	archivePath, archiveInfo, err := prepareRemoteArchiveManifest(job, resolvedPath, manifest)
	if err != nil {
		finishFolderArchiveWorker(job, err)
		return
	}
	if !job.markReady(archivePath, archiveInfo.Size()) {
		finishFolderArchiveWorker(job, context.Canceled)
	}
}

func cancelFolderArchiveJob(job *folderArchiveJob) {
	if job == nil {
		return
	}
	job.cancel()
	job.mu.Lock()
	terminal := job.status == "completed" || job.status == "error" || job.status == "cancelled"
	if !terminal {
		job.status = "cancelled"
		job.currentPath = ""
		job.updatedAt = time.Now()
	}
	job.mu.Unlock()
	if job.workFinished() {
		job.cleanupResources()
		scheduleFolderArchiveJobRemoval(job, folderArchiveJobResultTTL)
	}
}

func claimFolderArchiveDownload(job *folderArchiveJob) (*core.SSHClient, string, int64, string, error) {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.ctx.Err() != nil || job.status == "cancelled" {
		return nil, "", 0, "", context.Canceled
	}
	if job.status != "ready" || job.client == nil || job.archivePath == "" || job.archiveSize <= 0 {
		return nil, "", 0, "", fmt.Errorf("folder archive is not ready")
	}
	if job.readyTimer != nil {
		job.readyTimer.Stop()
		job.readyTimer = nil
	}
	job.status = "downloading"
	job.updatedAt = time.Now()
	return job.client, job.archivePath, job.archiveSize, job.downloadName, nil
}

func PrepareDirectoryArchive(c *gin.Context) {
	var request folderArchivePrepareRequest
	if err := bindStrictJSON(c, &request); err != nil {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid request: " + err.Error()})
		return
	}
	request.SSHInfo = strings.TrimSpace(request.SSHInfo)
	request.Path = pathpkg.Clean(strings.TrimSpace(request.Path))
	if request.SSHInfo == "" || request.Path == "." || request.Path == "" {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "missing sshInfo or path"})
		return
	}
	if request.Path == "/" {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "the remote root directory cannot be archived"})
		return
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		return
	}
	client, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		release()
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: err.Error()})
		return
	}
	owner, err := folderArchiveOwner(c)
	if err != nil {
		release()
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	jobID := strings.TrimSpace(request.JobID)
	if jobID != "" {
		if !validFolderArchiveJobID(jobID) {
			release()
			c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid folder archive job id"})
			return
		}
	} else {
		jobID, err = newFolderArchiveJobID()
		if err != nil {
			release()
			c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &folderArchiveJob{
		id:            jobID,
		owner:         owner,
		requestedPath: request.Path,
		downloadName:  remoteFolderArchiveDownloadName(request.Path),
		status:        "connecting",
		createdAt:     time.Now(),
		updatedAt:     time.Now(),
		ctx:           ctx,
		cancel:        cancel,
		client:        &client,
		release:       release,
		workDone:      make(chan struct{}),
	}
	// Cancelling the archive context must also close the underlying SSH/SFTP
	// connection. Context-aware reader/writer wrappers cannot interrupt an
	// SFTP request that is already blocked inside the transport; closing the
	// connection makes cancellation and the runtime timeout deterministic.
	job.stopIOCancel = closeSSHOnContextDone(ctx, job.client)
	job.runtimeTimer = time.AfterFunc(folderArchiveJobMaxRun, func() { cancelFolderArchiveJob(job) })
	storeResult := storeFolderArchiveJob(job)
	if storeResult != folderArchiveStoreOK {
		job.cancel()
		job.cleanupResources()
		switch storeResult {
		case folderArchiveStoreCancelled:
			c.JSON(http.StatusGone, ResponseBody{Msg: "folder archive job was cancelled"})
		case folderArchiveStoreConflict:
			c.JSON(http.StatusConflict, ResponseBody{Msg: "folder archive job id is already in use"})
		default:
			c.JSON(http.StatusServiceUnavailable, ResponseBody{Msg: "too many folder archive jobs"})
		}
		return
	}
	go runFolderArchiveJob(job)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, ResponseBody{Msg: "success", Data: gin.H{"jobId": jobID, "name": job.downloadName}})
}

func DirectoryArchiveStatus(c *gin.Context) {
	var request folderArchiveJobRequest
	if err := bindStrictJSON(c, &request); err != nil {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid request: " + err.Error()})
		return
	}
	owner, err := folderArchiveOwner(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	job := findFolderArchiveJob(owner, request.JobID)
	if job == nil {
		c.JSON(http.StatusNotFound, ResponseBody{Msg: "folder archive job was not found"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, ResponseBody{Msg: "success", Data: job.snapshot()})
}

func CancelDirectoryArchive(c *gin.Context) {
	var request folderArchiveJobRequest
	if err := bindStrictJSON(c, &request); err != nil {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid request: " + err.Error()})
		return
	}
	owner, err := folderArchiveOwner(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	request.JobID = strings.TrimSpace(request.JobID)
	if !validFolderArchiveJobID(request.JobID) {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid folder archive job id"})
		return
	}
	job, accepted := cancelOrRememberFolderArchiveJob(owner, request.JobID)
	if !accepted {
		c.JSON(http.StatusServiceUnavailable, ResponseBody{Msg: "too many pending folder archive cancellations"})
		return
	}
	if job != nil {
		cancelFolderArchiveJob(job)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, ResponseBody{Msg: "success"})
}

func DownloadPreparedDirectoryArchive(c *gin.Context) {
	var request folderArchiveJobRequest
	if err := bindStrictJSON(c, &request); err != nil {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid request: " + err.Error()})
		return
	}
	owner, err := folderArchiveOwner(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	job := findFolderArchiveJob(owner, request.JobID)
	if job == nil {
		c.JSON(http.StatusNotFound, ResponseBody{Msg: "folder archive job was not found"})
		return
	}
	client, archivePath, archiveSize, filename, err := claimFolderArchiveDownload(job)
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, context.Canceled) {
			status = http.StatusGone
		}
		c.JSON(status, ResponseBody{Msg: err.Error()})
		return
	}
	archiveFile, err := client.Download(archivePath)
	if err != nil {
		job.markTerminal("error", err)
		job.cleanupResources()
		deleteFolderArchiveJob(job)
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	streamCtx, stopStream := context.WithCancel(c.Request.Context())
	stopJobCancel := context.AfterFunc(job.ctx, stopStream)
	defer func() {
		stopJobCancel()
		stopStream()
		_ = archiveFile.Close()
		job.cleanupResources()
		deleteFolderArchiveJob(job)
	}()
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	c.Header("Content-Type", "application/gzip")
	c.Header("Content-Length", strconv.FormatInt(archiveSize, 10))
	c.Header("Cache-Control", "no-store")
	c.Header("Accept-Ranges", "none")
	c.Header("X-WebSSH-File-Size", strconv.FormatInt(archiveSize, 10))
	c.Header("X-WebSSH-Download-Kind", "directory-archive")
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-WebSSH-File-Size, X-WebSSH-Download-Kind")
	c.Status(http.StatusOK)
	copied, copyErr := io.Copy(c.Writer, requestContextReader{ctx: streamCtx, r: archiveFile})
	if copyErr == nil && copied != archiveSize {
		copyErr = fmt.Errorf("download size changed while streaming: copied %d bytes, expected %d", copied, archiveSize)
	}
	if copyErr != nil {
		if streamCtx.Err() != nil || job.ctx.Err() != nil {
			job.markTerminal("cancelled", nil)
		} else {
			job.markTerminal("error", copyErr)
		}
		_ = c.Error(copyErr)
		c.Abort()
		return
	}
	job.markTerminal("completed", nil)
}
