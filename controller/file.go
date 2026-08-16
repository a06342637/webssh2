package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type File struct {
	Name           string
	Size           string
	SizeBytes      int64
	ModifyTime     string
	IsDir          bool
	IsSymlink      bool
	Editable       bool
	EditReason     string
	Previewable    bool
	PreviewKind    string
	PreviewMime    string
	PreviewReason  string
	Downloadable   bool
	DownloadReason string
}

type fileRequest struct {
	SSHInfo   string `json:"sshInfo"`
	Path      string `json:"path"`
	SessionID string `json:"sessionId,omitempty"`
	Archive   *bool  `json:"archive,omitempty"`
}

type fileRenameRequest struct {
	SSHInfo   string `json:"sshInfo"`
	Path      string `json:"path"`
	NewName   string `json:"newName"`
	SessionID string `json:"sessionId,omitempty"`
}

type fileSaveRequest struct {
	SSHInfo    string `json:"sshInfo"`
	Path       string `json:"path"`
	TargetPath string `json:"targetPath"`
	Content    string `json:"content"`
	Version    string `json:"version"`
	Create     bool   `json:"create"`
}

type remoteFileSnapshot struct {
	Content    string
	Version    string
	TargetPath string
	Size       int64
	Mode       os.FileMode
	Modified   time.Time
	Stat       *sftp.FileStat
}

type remoteEditorTargetLock struct {
	token chan struct{}
	refs  int
}

var remoteEditorTargetLocks = struct {
	sync.Mutex
	entries map[string]*remoteEditorTargetLock
}{entries: make(map[string]*remoteEditorTargetLock)}

func validateRemoteTextContent(content []byte, maxBytes int64, action, pastAction string) error {
	if int64(len(content)) > maxBytes {
		return fmt.Errorf("file is too large to %s (maximum %s)", action, Bytefmt(uint64(maxBytes)))
	}
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return fmt.Errorf("only UTF-8 text files can be %s", pastAction)
	}
	return nil
}

func bindFileRequest(c *gin.Context) (fileRequest, error) {
	var request fileRequest
	if err := bindStrictJSON(c, &request); err != nil {
		return request, fmt.Errorf("invalid request: %w", err)
	}
	if strings.TrimSpace(request.SSHInfo) == "" {
		return request, fmt.Errorf("missing sshInfo")
	}
	return request, nil
}

func bindDownloadRequest(c *gin.Context) (fileRequest, error) {
	contentType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err == nil && strings.EqualFold(contentType, "application/json") {
		return bindFileRequest(c)
	}
	if err == nil && strings.EqualFold(contentType, "application/x-www-form-urlencoded") {
		readTimer := time.AfterFunc(30*time.Second, func() { _ = c.Request.Body.Close() })
		defer readTimer.Stop()
		if err := c.Request.ParseForm(); err != nil {
			return fileRequest{}, fmt.Errorf("invalid request: %w", err)
		}
		request := fileRequest{SSHInfo: c.Request.PostForm.Get("sshInfo"), Path: c.Request.PostForm.Get("path")}
		if rawArchive := strings.TrimSpace(c.Request.PostForm.Get("archive")); rawArchive != "" {
			archive, parseErr := strconv.ParseBool(rawArchive)
			if parseErr != nil {
				return fileRequest{}, fmt.Errorf("invalid archive intent: %w", parseErr)
			}
			request.Archive = &archive
		}
		if strings.TrimSpace(request.SSHInfo) == "" {
			return request, fmt.Errorf("missing sshInfo")
		}
		return request, nil
	}
	return fileRequest{}, fmt.Errorf("invalid request content type")
}

const (
	BYTE = 1 << (10 * iota)
	KILOBYTE
	MEGABYTE
	GIGABYTE
	TERABYTE
	PETABYTE
	EXABYTE
)

func Bytefmt(bytes uint64) string {
	unit := ""
	value := float64(bytes)
	switch {
	case bytes >= EXABYTE:
		unit = "E"
		value = value / EXABYTE
	case bytes >= PETABYTE:
		unit = "P"
		value = value / PETABYTE
	case bytes >= TERABYTE:
		unit = "T"
		value = value / TERABYTE
	case bytes >= GIGABYTE:
		unit = "G"
		value = value / GIGABYTE
	case bytes >= MEGABYTE:
		unit = "M"
		value = value / MEGABYTE
	case bytes >= KILOBYTE:
		unit = "K"
		value = value / KILOBYTE
	case bytes >= BYTE:
		unit = "B"
	case bytes == 0:
		return "0B"
	}
	result := strconv.FormatFloat(value, 'f', 2, 64)
	result = strings.TrimSuffix(result, ".00")
	return result + unit
}

func formatRemoteFileSize(size int64, isDir bool) string {
	if size < 0 {
		size = 0
	}
	if isDir {
		return strconv.FormatInt(size, 10)
	}
	return Bytefmt(uint64(size))
}

func statRemoteTarget(client *sftp.Client, remotePath string) (os.FileInfo, string, error) {
	remotePath = pathpkg.Clean(strings.TrimSpace(remotePath))
	if remotePath == "." || remotePath == "" {
		return nil, "", fmt.Errorf("missing path")
	}
	seen := make(map[string]struct{})
	for depth := 0; depth < 32; depth++ {
		if _, exists := seen[remotePath]; exists {
			return nil, remotePath, fmt.Errorf("symbolic link loop detected")
		}
		seen[remotePath] = struct{}{}
		info, err := client.Lstat(remotePath)
		if err != nil {
			return nil, remotePath, err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return info, remotePath, nil
		}
		target, err := client.ReadLink(remotePath)
		if err != nil {
			return nil, remotePath, err
		}
		if !pathpkg.IsAbs(target) {
			target = pathpkg.Join(pathpkg.Dir(remotePath), target)
		}
		remotePath = pathpkg.Clean(target)
	}
	return nil, remotePath, fmt.Errorf("too many symbolic link levels")
}

const defaultRemoteEditorMaxBytes = int64(2 << 20)

const defaultRemotePreviewMaxBytes = int64(128 << 20)

type remotePreviewSpec struct {
	Kind string
	MIME string
}

var remotePreviewTypes = map[string]remotePreviewSpec{
	".jpg":  {Kind: "image", MIME: "image/jpeg"},
	".jpeg": {Kind: "image", MIME: "image/jpeg"},
	".png":  {Kind: "image", MIME: "image/png"},
	".gif":  {Kind: "image", MIME: "image/gif"},
	".webp": {Kind: "image", MIME: "image/webp"},
	".bmp":  {Kind: "image", MIME: "image/bmp"},
	".avif": {Kind: "image", MIME: "image/avif"},
	".svg":  {Kind: "image", MIME: "image/svg+xml"},
	".ico":  {Kind: "image", MIME: "image/x-icon"},
	".mp4":  {Kind: "video", MIME: "video/mp4"},
	".webm": {Kind: "video", MIME: "video/webm"},
	".ogg":  {Kind: "video", MIME: "video/ogg"},
	".ogv":  {Kind: "video", MIME: "video/ogg"},
	".mov":  {Kind: "video", MIME: "video/quicktime"},
	".m4v":  {Kind: "video", MIME: "video/x-m4v"},
}

func remotePreviewSpecForName(name string) (remotePreviewSpec, bool) {
	spec, ok := remotePreviewTypes[strings.ToLower(pathpkg.Ext(strings.TrimSpace(name)))]
	return spec, ok
}

func remotePreviewMaxBytes() int64 {
	const maxRemotePreviewBytes = int64(1 << 30)
	raw := strings.TrimSpace(os.Getenv("WEBSSH_PREVIEW_MAX_BYTES"))
	if raw == "" {
		return defaultRemotePreviewMaxBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1<<20 || value > maxRemotePreviewBytes {
		return defaultRemotePreviewMaxBytes
	}
	return value
}

func RemotePreviewMaxBytes() int64 {
	return remotePreviewMaxBytes()
}

func remoteEditorMaxBytes() int64 {
	const maxRemoteEditorBytes = int64(64 << 20)
	raw := strings.TrimSpace(os.Getenv("WEBSSH_EDITOR_MAX_BYTES"))
	if raw == "" {
		return defaultRemoteEditorMaxBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1024 || value > maxRemoteEditorBytes {
		return defaultRemoteEditorMaxBytes
	}
	return value
}

func RemoteEditorMaxBytes() int64 {
	return remoteEditorMaxBytes()
}

func RemoteEditorRequestBodyLimit() int64 {
	// JSON.stringify may escape one input byte into as many as six ASCII bytes
	// (for example '<' or a control character).  Leave additional room for the
	// SSH payload, field names and JSON framing so the advertised editor limit
	// remains usable for all valid UTF-8 text.
	const (
		jsonExpansion = int64(6)
		overhead      = int64(4 << 20)
		maxInt64      = int64(1<<63 - 1)
	)
	maxBytes := remoteEditorMaxBytes()
	if maxBytes > (maxInt64-overhead)/jsonExpansion {
		return maxInt64
	}
	return maxBytes*jsonExpansion + overhead
}

func resolveRemotePreviewTarget(client *sftp.Client, requestedPath string, maxBytes int64) (os.FileInfo, string, remotePreviewSpec, error) {
	requestedPath = strings.TrimSpace(requestedPath)
	if requestedPath == "" {
		return nil, "", remotePreviewSpec{}, fmt.Errorf("missing path")
	}
	spec, ok := remotePreviewSpecForName(pathpkg.Base(requestedPath))
	if !ok {
		return nil, "", remotePreviewSpec{}, fmt.Errorf("this file type does not support online preview")
	}
	info, targetPath, err := statRemoteTarget(client, requestedPath)
	if err != nil {
		return nil, targetPath, remotePreviewSpec{}, err
	}
	if !info.Mode().IsRegular() {
		return nil, targetPath, remotePreviewSpec{}, fmt.Errorf("only regular files can be previewed")
	}
	if info.Size() < 0 || info.Size() > maxBytes {
		return nil, targetPath, remotePreviewSpec{}, fmt.Errorf("file is too large to preview (maximum %s)", Bytefmt(uint64(maxBytes)))
	}
	return info, targetPath, spec, nil
}

func remoteEditorTargetKey(client core.SSHClient, path string) string {
	return strings.Join([]string{
		strings.ToLower(strings.TrimSpace(client.Hostname)),
		strconv.Itoa(client.Port),
		strings.TrimSpace(client.Username),
		pathpkg.Clean(strings.TrimSpace(path)),
	}, "\x00")
}

func acquireRemoteEditorTarget(ctx context.Context, key string) (func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	remoteEditorTargetLocks.Lock()
	entry := remoteEditorTargetLocks.entries[key]
	if entry == nil {
		entry = &remoteEditorTargetLock{token: make(chan struct{}, 1)}
		entry.token <- struct{}{}
		remoteEditorTargetLocks.entries[key] = entry
	}
	entry.refs++
	remoteEditorTargetLocks.Unlock()

	releaseReference := func() {
		remoteEditorTargetLocks.Lock()
		entry.refs--
		if entry.refs == 0 && remoteEditorTargetLocks.entries[key] == entry {
			delete(remoteEditorTargetLocks.entries, key)
		}
		remoteEditorTargetLocks.Unlock()
	}

	select {
	case <-entry.token:
		var once sync.Once
		return func() {
			once.Do(func() {
				entry.token <- struct{}{}
				releaseReference()
			})
		}, nil
	case <-ctx.Done():
		releaseReference()
		return nil, ctx.Err()
	}
}

func acquireRemoteEditorTargets(ctx context.Context, keys ...string) (func(), error) {
	unique := make(map[string]struct{}, len(keys))
	ordered := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := unique[key]; exists {
			continue
		}
		unique[key] = struct{}{}
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	releases := make([]func(), 0, len(ordered))
	for _, key := range ordered {
		release, err := acquireRemoteEditorTarget(ctx, key)
		if err != nil {
			for i := len(releases) - 1; i >= 0; i-- {
				releases[i]()
			}
			return nil, err
		}
		releases = append(releases, release)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for i := len(releases) - 1; i >= 0; i-- {
				releases[i]()
			}
		})
	}, nil
}

func remoteFileVersion(info os.FileInfo, content []byte) string {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%d\n%d\n%o\n", info.Size(), info.ModTime().UnixNano(), info.Mode())
	_, _ = hash.Write(content)
	return hex.EncodeToString(hash.Sum(nil))
}

func resolveRemoteTextTarget(client *sftp.Client, requestedPath string) (os.FileInfo, string, error) {
	requestedPath = strings.TrimSpace(requestedPath)
	if requestedPath == "" {
		return nil, "", fmt.Errorf("missing path")
	}
	info, targetPath, err := statRemoteTarget(client, requestedPath)
	if err != nil {
		return nil, targetPath, err
	}
	if !info.Mode().IsRegular() {
		return nil, targetPath, fmt.Errorf("only regular files can be edited")
	}
	return info, targetPath, nil
}

func readRemoteTextFile(client *sftp.Client, path string, maxBytes int64) (remoteFileSnapshot, error) {
	info, targetPath, err := resolveRemoteTextTarget(client, path)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if info.Size() > maxBytes {
		return remoteFileSnapshot{}, fmt.Errorf("file is too large to edit (maximum %s)", Bytefmt(uint64(maxBytes)))
	}
	file, err := client.Open(targetPath)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if err := validateRemoteTextContent(content, maxBytes, "edit", "edited"); err != nil {
		return remoteFileSnapshot{}, err
	}
	return remoteFileSnapshot{
		Content:    string(content),
		Version:    remoteFileVersion(info, content),
		TargetPath: targetPath,
		Size:       int64(len(content)),
		Mode:       info.Mode(),
		Modified:   info.ModTime(),
		Stat:       cloneSFTPFileStat(info),
	}, nil
}

func cloneSFTPFileStat(info os.FileInfo) *sftp.FileStat {
	stat, ok := info.Sys().(*sftp.FileStat)
	if !ok || stat == nil {
		return nil
	}
	cloned := *stat
	return &cloned
}

func writeRemoteTextFile(client *sftp.Client, path string, content []byte, expectedVersion string, maxBytes int64) (remoteFileSnapshot, error) {
	return writeRemoteTextFileTarget(client, path, content, expectedVersion, "", maxBytes)
}

func writeRemoteTextFileTarget(client *sftp.Client, path string, content []byte, expectedVersion, expectedTargetPath string, maxBytes int64) (remoteFileSnapshot, error) {
	if err := validateRemoteTextContent(content, maxBytes, "save", "saved"); err != nil {
		return remoteFileSnapshot{}, err
	}
	current, err := readRemoteTextFile(client, path, maxBytes)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	expectedTargetPath = strings.TrimSpace(expectedTargetPath)
	if expectedTargetPath != "" {
		expectedTargetPath = pathpkg.Clean(expectedTargetPath)
		if current.TargetPath != expectedTargetPath {
			return remoteFileSnapshot{}, fmt.Errorf("the symbolic link target changed after the file was opened; reopen it before saving")
		}
	}
	targetPath := current.TargetPath
	if strings.TrimSpace(expectedVersion) == "" {
		return remoteFileSnapshot{}, fmt.Errorf("missing file version")
	}
	expectedVersion = strings.TrimSpace(expectedVersion)
	if current.Version != expectedVersion {
		return remoteFileSnapshot{}, fmt.Errorf("the remote file changed after it was opened; reload it before saving")
	}
	randomBytes := make([]byte, 12)
	if _, err := rand.Read(randomBytes); err != nil {
		return remoteFileSnapshot{}, fmt.Errorf("create editor temp name: %w", err)
	}
	tmpPath := pathpkg.Join(pathpkg.Dir(targetPath), ".webssh-edit-"+hex.EncodeToString(randomBytes)+".tmp")
	tmpFile, err := client.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	committed := false
	defer func() {
		_ = tmpFile.Close()
		if !committed {
			_ = client.Remove(tmpPath)
		}
	}()
	// Keep the random temporary file private while it is incomplete.  Apply
	// the original mode only after writes/chown, because either operation may
	// clear setuid/setgid bits on Unix servers.
	if err := tmpFile.Chmod(0o600); err != nil {
		return remoteFileSnapshot{}, err
	}
	if _, err := io.Copy(tmpFile, bytes.NewReader(content)); err != nil {
		return remoteFileSnapshot{}, err
	}
	if current.Stat != nil {
		// The temporary file normally has the same owner because it is created
		// by the logged-in SSH account.  When elevated SFTP accounts edit files
		// owned by another uid/gid, preserve that metadata as well.  A permission
		// denial is surfaced instead of silently changing ownership.
		if tmpInfo, statErr := tmpFile.Stat(); statErr != nil {
			return remoteFileSnapshot{}, statErr
		} else if tmpStat := cloneSFTPFileStat(tmpInfo); tmpStat != nil && (tmpStat.UID != current.Stat.UID || tmpStat.GID != current.Stat.GID) {
			if err := tmpFile.Chown(int(current.Stat.UID), int(current.Stat.GID)); err != nil {
				return remoteFileSnapshot{}, err
			}
		}
	}
	if err := tmpFile.Chmod(current.Mode); err != nil {
		return remoteFileSnapshot{}, err
	}
	if err := tmpFile.Sync(); err != nil && !isSFTPUnsupported(err) {
		return remoteFileSnapshot{}, err
	}
	if err := tmpFile.Close(); err != nil {
		return remoteFileSnapshot{}, err
	}
	latest, err := readRemoteTextFile(client, path, maxBytes)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if latest.TargetPath != targetPath {
		return remoteFileSnapshot{}, fmt.Errorf("the symbolic link target changed while the file was being saved; reopen it before trying again")
	}
	if latest.Version != expectedVersion {
		return remoteFileSnapshot{}, fmt.Errorf("the remote file changed while it was being saved; reload it before trying again")
	}
	// Re-check the link type immediately before the commit.  This closes the
	// most important replace-via-link race without weakening the optimistic
	// version check above.
	latestLstat, err := client.Lstat(targetPath)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if latestLstat.Mode()&os.ModeSymlink != 0 || !latestLstat.Mode().IsRegular() {
		return remoteFileSnapshot{}, fmt.Errorf("the remote file is no longer a regular file")
	}
	if err := replaceRemoteFile(client, tmpPath, targetPath); err != nil {
		return remoteFileSnapshot{}, err
	}
	committed = true
	return readRemoteTextFile(client, targetPath, maxBytes)
}

func createRemoteTextFile(client *sftp.Client, path string, content []byte, maxBytes int64) (remoteFileSnapshot, error) {
	path = strings.TrimSpace(path)
	name := pathpkg.Base(path)
	if path == "" || path == "/" || name == "." || name == ".." || name == "/" || len([]byte(name)) > 255 || strings.IndexFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return remoteFileSnapshot{}, fmt.Errorf("invalid file path")
	}
	if err := validateRemoteTextContent(content, maxBytes, "save", "saved"); err != nil {
		return remoteFileSnapshot{}, err
	}
	parentInfo, err := client.Stat(pathpkg.Dir(path))
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if !parentInfo.IsDir() {
		return remoteFileSnapshot{}, fmt.Errorf("parent path is not a directory")
	}
	file, err := client.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		if _, statErr := client.Lstat(path); statErr == nil {
			return remoteFileSnapshot{}, fmt.Errorf("a file or directory with this name already exists")
		}
		return remoteFileSnapshot{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	if _, err := io.Copy(file, bytes.NewReader(content)); err != nil {
		return remoteFileSnapshot{}, fmt.Errorf("create file write failed; an incomplete file may remain: %w", err)
	}
	if err := file.Sync(); err != nil && !isSFTPUnsupported(err) {
		return remoteFileSnapshot{}, fmt.Errorf("create file sync failed; an incomplete file may remain: %w", err)
	}
	if err := file.Close(); err != nil {
		return remoteFileSnapshot{}, fmt.Errorf("create file close failed; verify the remote file before retrying: %w", err)
	}
	closed = true
	// Re-read after close because some SFTP servers finalize size or mtime only
	// when the handle is closed. Returning a pre-close fingerprint would make
	// the very next editor save look like an external conflict.
	snapshot, err := readRemoteTextFile(client, path, maxBytes)
	if err != nil {
		return remoteFileSnapshot{}, fmt.Errorf("file was created but verification failed; reopen it before retrying: %w", err)
	}
	return snapshot, nil
}

func saveRemoteTextFileWithLock(ctx context.Context, lockKey string, client *sftp.Client, request fileSaveRequest, maxBytes int64) (remoteFileSnapshot, error) {
	release, err := acquireRemoteEditorTarget(ctx, lockKey)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	defer release()
	if request.Create {
		if strings.TrimSpace(request.Version) != "" {
			return remoteFileSnapshot{}, fmt.Errorf("new files must not include an existing version")
		}
		if strings.TrimSpace(request.TargetPath) != "" {
			return remoteFileSnapshot{}, fmt.Errorf("new files must not include an existing target path")
		}
		return createRemoteTextFile(client, request.Path, []byte(request.Content), maxBytes)
	}
	return writeRemoteTextFileTarget(client, request.Path, []byte(request.Content), request.Version, request.TargetPath, maxBytes)
}

func remoteSnapshotData(path string, snapshot remoteFileSnapshot, maxBytes int64) gin.H {
	requestedPath := pathpkg.Clean(strings.TrimSpace(path))
	return gin.H{
		"path":       requestedPath,
		"targetPath": snapshot.TargetPath,
		"isSymlink":  snapshot.TargetPath != "" && snapshot.TargetPath != requestedPath,
		"name":       pathpkg.Base(requestedPath),
		"content":    snapshot.Content,
		"version":    snapshot.Version,
		"size":       snapshot.Size,
		"mode":       fmt.Sprintf("%04o", snapshot.Mode.Perm()),
		"modifiedAt": snapshot.Modified.Format(time.RFC3339),
		"maxBytes":   maxBytes,
	}
}

func OpenFileForEdit(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	path := strings.TrimSpace(request.Path)
	maxBytes := remoteEditorMaxBytes()
	snapshot, err := readRemoteTextFile(sshClient.Sftp, path, maxBytes)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = remoteSnapshotData(path, snapshot, maxBytes)
	return &responseBody
}

func PreviewFile(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		c.JSON(http.StatusTooManyRequests, responseBody)
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()

	requestedPath := strings.TrimSpace(request.Path)
	maxBytes := remotePreviewMaxBytes()
	info, targetPath, spec, err := resolveRemotePreviewTarget(sshClient.Sftp, requestedPath, maxBytes)
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	file, err := sshClient.Sftp.Open(targetPath)
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	if !openedInfo.Mode().IsRegular() || openedInfo.Size() < 0 || openedInfo.Size() > maxBytes {
		responseBody.Msg = "preview target changed after it was checked"
		c.JSON(http.StatusConflict, responseBody)
		return &responseBody
	}
	info = openedInfo

	filename := pathpkg.Base(requestedPath)
	if filename == "." || filename == "/" || filename == "" {
		filename = "preview"
	}
	c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
	c.Header("Content-Type", spec.MIME)
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	c.Header("Cache-Control", "no-store")
	c.Header("Accept-Ranges", "none")
	c.Header("X-WebSSH-Preview-Kind", spec.Kind)
	c.Header("X-WebSSH-File-Size", strconv.FormatInt(info.Size(), 10))
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-WebSSH-Preview-Kind, X-WebSSH-File-Size")
	c.Status(http.StatusOK)
	copied, copyErr := io.Copy(c.Writer, requestContextReader{ctx: c.Request.Context(), r: io.LimitReader(file, info.Size()+1)})
	if copyErr == nil && copied != info.Size() {
		copyErr = fmt.Errorf("preview size changed while streaming: copied %d bytes, expected %d", copied, info.Size())
	}
	if copyErr != nil {
		responseBody.Msg = copyErr.Error()
		_ = c.Error(copyErr)
		c.Abort()
	}
	return &responseBody
}

func SaveEditedFile(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	var request fileSaveRequest
	if err := bindStrictJSON(c, &request); err != nil {
		responseBody.Msg = fmt.Errorf("invalid request: %w", err).Error()
		return &responseBody
	}
	if strings.TrimSpace(request.SSHInfo) == "" {
		responseBody.Msg = "missing sshInfo"
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	path := strings.TrimSpace(request.Path)
	request.Path = path
	maxBytes := remoteEditorMaxBytes()
	lockPath := path
	if !request.Create {
		request.TargetPath = strings.TrimSpace(request.TargetPath)
		if request.TargetPath == "" {
			_, resolvedPath, resolveErr := resolveRemoteTextTarget(sshClient.Sftp, path)
			if resolveErr != nil {
				responseBody.Msg = resolveErr.Error()
				return &responseBody
			}
			request.TargetPath = resolvedPath
		} else {
			request.TargetPath = pathpkg.Clean(request.TargetPath)
		}
		lockPath = request.TargetPath
	}
	snapshot, err := saveRemoteTextFileWithLock(c.Request.Context(), remoteEditorTargetKey(sshClient, lockPath), sshClient.Sftp, request, maxBytes)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = remoteSnapshotData(path, snapshot, maxBytes)
	return &responseBody
}

func deleteRemoteFile(client *sftp.Client, remotePath string) error {
	remotePath = strings.TrimSpace(remotePath)
	if remotePath == "" {
		return fmt.Errorf("missing path")
	}
	remotePath = pathpkg.Clean(remotePath)
	if remotePath == "." || remotePath == "/" {
		return fmt.Errorf("invalid file path")
	}
	info, err := client.Lstat(remotePath)
	if err != nil {
		if os.IsNotExist(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
			return fmt.Errorf("file does not exist")
		}
		if os.IsPermission(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxPermissionDenied)) {
			return fmt.Errorf("permission denied")
		}
		return err
	}
	// Lstat deliberately does not follow symbolic links: deleting a link must
	// remove the link itself, never the file or directory it points at.
	if info.IsDir() {
		return fmt.Errorf("directories cannot be deleted")
	}
	if err := client.Remove(remotePath); err != nil {
		if os.IsNotExist(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
			return fmt.Errorf("file does not exist")
		}
		if os.IsPermission(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxPermissionDenied)) {
			return fmt.Errorf("permission denied")
		}
		return err
	}
	return nil
}

func deleteRemoteFileWithLock(ctx context.Context, lockKey string, client *sftp.Client, remotePath string) error {
	release, err := acquireRemoteEditorTarget(ctx, lockKey)
	if err != nil {
		return err
	}
	defer release()
	return deleteRemoteFile(client, remotePath)
}

func DeleteFile(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	remotePath := pathpkg.Clean(strings.TrimSpace(request.Path))
	if remotePath == "." || remotePath == "/" {
		responseBody.Msg = "invalid file path"
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	if err := deleteRemoteFileWithLock(c.Request.Context(), remoteEditorTargetKey(sshClient, remotePath), sshClient.Sftp, remotePath); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = gin.H{"path": remotePath, "name": pathpkg.Base(remotePath)}
	return &responseBody
}

func validateRemoteRenameName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("请输入有效的新名称")
	}
	if !utf8.ValidString(name) || len([]byte(name)) > 255 {
		return "", fmt.Errorf("名称必须是有效 UTF-8，且不能超过 255 字节")
	}
	if strings.ContainsAny(name, "/\\\x00") {
		return "", fmt.Errorf("名称不能包含 / 或 \\")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("名称不能包含控制字符")
		}
	}
	return name, nil
}

func renameRemotePath(ctx context.Context, sshClient core.SSHClient, client *sftp.Client, sourcePath, newName string) (string, bool, error) {
	sourcePath = pathpkg.Clean(strings.TrimSpace(sourcePath))
	if sourcePath == "." || sourcePath == "/" || sourcePath == "" {
		return "", false, fmt.Errorf("不能重命名根目录")
	}
	newName, err := validateRemoteRenameName(newName)
	if err != nil {
		return "", false, err
	}
	targetPath := pathpkg.Join(pathpkg.Dir(sourcePath), newName)
	if targetPath == sourcePath {
		return "", false, fmt.Errorf("新名称与原名称相同")
	}
	release, err := acquireRemoteEditorTargets(ctx,
		remoteEditorTargetKey(sshClient, sourcePath),
		remoteEditorTargetKey(sshClient, targetPath),
	)
	if err != nil {
		return "", false, err
	}
	defer release()
	sourceInfo, err := client.Lstat(sourcePath)
	if err != nil {
		if os.IsNotExist(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
			return "", false, fmt.Errorf("原文件或文件夹不存在")
		}
		if os.IsPermission(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxPermissionDenied)) {
			return "", false, fmt.Errorf("没有权限读取原路径")
		}
		return "", false, err
	}
	sourceIsDir := sourceInfo.IsDir()
	if sourceInfo.Mode()&os.ModeSymlink != 0 {
		if resolvedInfo, statErr := client.Stat(sourcePath); statErr == nil {
			sourceIsDir = resolvedInfo.IsDir()
		}
	}
	if _, err := client.Lstat(targetPath); err == nil {
		return "", sourceIsDir, fmt.Errorf("同目录下已存在名为 %s 的项目", newName)
	} else if !os.IsNotExist(err) && !isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
		if os.IsPermission(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxPermissionDenied)) {
			return "", sourceIsDir, fmt.Errorf("没有权限检查目标路径")
		}
		return "", sourceIsDir, err
	}
	if err := client.Rename(sourcePath, targetPath); err != nil {
		if os.IsPermission(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxPermissionDenied)) {
			return "", sourceIsDir, fmt.Errorf("没有权限重命名此项目")
		}
		if os.IsNotExist(err) || isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
			return "", sourceIsDir, fmt.Errorf("原文件或文件夹已不存在")
		}
		return "", sourceIsDir, err
	}
	return targetPath, sourceIsDir, nil
}

func RenameFile(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	var request fileRenameRequest
	if err := bindStrictJSON(c, &request); err != nil {
		responseBody.Msg = fmt.Errorf("invalid request: %w", err).Error()
		return &responseBody
	}
	if strings.TrimSpace(request.SSHInfo) == "" {
		responseBody.Msg = "missing sshInfo"
		return &responseBody
	}
	if _, err := normalizeSFTPSessionID(request.SessionID); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	lease, err := acquireSFTPSessionLease(c, request.SessionID, request.SSHInfo, sshClient)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	discardLease := false
	defer func() { lease.Release(discardLease) }()
	newPath, isDir, err := renameRemotePath(c.Request.Context(), *lease.Client, lease.Client.Sftp, request.Path, request.NewName)
	if err != nil {
		discardLease = sftpSessionConnectionBroken(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = gin.H{
		"oldPath": pathpkg.Clean(strings.TrimSpace(request.Path)),
		"newPath": newPath,
		"name":    pathpkg.Base(newPath),
		"isDir":   isDir,
	}
	return &responseBody
}

type fileSplice []File

func (f fileSplice) Len() int      { return len(f) }
func (f fileSplice) Swap(i, j int) { f[i], f[j] = f[j], f[i] }
func (f fileSplice) Less(i, j int) bool {
	if f[i].IsDir != f[j].IsDir {
		return f[i].IsDir
	}
	return strings.ToLower(f[i].Name) < strings.ToLower(f[j].Name)
}

func UploadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	releaseUpload, ok := acquireUploadSlot(c)
	if !ok {
		responseBody.Msg = "上传任务过多，请稍后重试"
		return &responseBody
	}
	defer releaseUpload()
	// Apply the body limit before ParseMultipartForm/PostForm reads any bytes.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, uploadMaxBytes()+(1<<20))
	sshInfo := c.PostForm("sshInfo")
	id := c.PostForm("id")
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	if sshClient, err = decodeSSHClient(c, sshInfo); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer file.Close()
	path := strings.TrimSpace(c.DefaultPostForm("path", ""))
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	pathArr := []string{strings.TrimRight(path, "/")}
	if dir := c.DefaultPostForm("dir", ""); dir != "" {
		pathArr = append(pathArr, dir)
		if err := sshClient.Mkdirs(strings.Join(pathArr, "/")); err != nil {
			responseBody.Msg = err.Error()
			return &responseBody
		}
	}
	filename := sanitizeRemoteFilename(header.Filename)
	if filename == "" {
		responseBody.Msg = "invalid upload filename"
		return &responseBody
	}
	pathArr = append(pathArr, filename)
	err = sshClient.Upload(c.Request.Context(), file, id, strings.Join(pathArr, "/"))
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
	}
	return &responseBody
}

const (
	remoteFolderArchivePrefix = ".webssh-folder-"
	remoteFolderArchiveSuffix = ".tar.gz"
)

type remoteDirectoryArchiver func(ctx context.Context, sourcePath, archivePath string) error

type cappedCommandOutput struct {
	data []byte
	max  int
}

func (w *cappedCommandOutput) Write(p []byte) (int, error) {
	written := len(p)
	if w.max <= 0 || len(w.data) >= w.max {
		return written, nil
	}
	remaining := w.max - len(w.data)
	if len(p) > remaining {
		p = p[:remaining]
	}
	w.data = append(w.data, p...)
	return written, nil
}

func (w *cappedCommandOutput) String() string {
	return strings.TrimSpace(string(w.data))
}

func runSSHCommandContext(ctx context.Context, client *ssh.Client, command string) error {
	if client == nil {
		return fmt.Errorf("SSH connection is not available")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	stderr := &cappedCommandOutput{max: 8 << 10}
	session.Stdout = io.Discard
	session.Stderr = stderr
	if err := session.Start(command); err != nil {
		return err
	}
	wait := make(chan error, 1)
	go func() { wait <- session.Wait() }()
	select {
	case err := <-wait:
		if err == nil {
			return nil
		}
		if detail := stderr.String(); detail != "" {
			return fmt.Errorf("remote command failed: %w: %s", err, detail)
		}
		return fmt.Errorf("remote command failed: %w", err)
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGTERM)
		_ = session.Close()
		select {
		case <-wait:
		case <-time.After(2 * time.Second):
		}
		return ctx.Err()
	}
}

func remoteTarArchiveCommand(sourcePath, archivePath string) string {
	sourcePath = pathpkg.Clean(sourcePath)
	archivePath = pathpkg.Clean(archivePath)
	return strings.Join([]string{
		"set -eu",
		"umask 077",
		"command -v tar >/dev/null 2>&1 || { echo 'tar command is not installed on the remote server' >&2; exit 127; }",
		"[ -d " + shellQuote(sourcePath) + " ] && [ ! -L " + shellQuote(sourcePath) + " ] || { echo 'folder changed before it could be archived' >&2; exit 1; }",
		"tar -czf " + shellQuote(archivePath) + " -C " + shellQuote(pathpkg.Dir(sourcePath)) + " -- " + shellQuote(pathpkg.Base(sourcePath)),
	}, "\n")
}

func runRemoteTarArchive(ctx context.Context, client *ssh.Client, sourcePath, archivePath string) error {
	return runSSHCommandContext(ctx, client, remoteTarArchiveCommand(sourcePath, archivePath))
}

func remoteFolderArchiveCandidateDirs(sourcePath string) []string {
	candidates := []string{pathpkg.Dir(sourcePath), "/tmp"}
	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidate = pathpkg.Clean(candidate)
		if candidate == "." || candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	return result
}

func remotePathWithin(remotePath, directory string) bool {
	remotePath = pathpkg.Clean(remotePath)
	directory = pathpkg.Clean(directory)
	if directory == "/" {
		return strings.HasPrefix(remotePath, "/")
	}
	return remotePath == directory || strings.HasPrefix(remotePath, strings.TrimSuffix(directory, "/")+"/")
}

func reserveRemoteFolderArchive(client *sftp.Client, directory string) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		randomBytes := make([]byte, 12)
		if _, err := rand.Read(randomBytes); err != nil {
			return "", fmt.Errorf("create archive temp name: %w", err)
		}
		archivePath := pathpkg.Join(directory, remoteFolderArchivePrefix+hex.EncodeToString(randomBytes)+remoteFolderArchiveSuffix)
		file, err := client.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return "", err
		}
		if err := file.Chmod(0o600); err != nil {
			_ = file.Close()
			_ = client.Remove(archivePath)
			return "", err
		}
		if err := file.Close(); err != nil {
			_ = client.Remove(archivePath)
			return "", err
		}
		return archivePath, nil
	}
	return "", fmt.Errorf("could not reserve a unique archive name")
}

func isRemoteFolderArchiveName(name string) bool {
	if !strings.HasPrefix(name, remoteFolderArchivePrefix) || !strings.HasSuffix(name, remoteFolderArchiveSuffix) {
		return false
	}
	token := strings.TrimSuffix(strings.TrimPrefix(name, remoteFolderArchivePrefix), remoteFolderArchiveSuffix)
	if len(token) != 24 {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil
}

func removeRemoteFolderArchive(client *sftp.Client, archivePath string) error {
	archivePath = pathpkg.Clean(strings.TrimSpace(archivePath))
	name := pathpkg.Base(archivePath)
	if archivePath == "." || !isRemoteFolderArchiveName(name) {
		return fmt.Errorf("invalid temporary archive path")
	}
	if err := client.Remove(archivePath); err != nil && !os.IsNotExist(err) && !isSFTPStatus(err, uint32(sftp.ErrSSHFxNoSuchFile)) {
		return err
	}
	return nil
}

func prepareRemoteDirectoryArchive(ctx context.Context, client *sftp.Client, sourcePath string, archive remoteDirectoryArchiver) (string, os.FileInfo, error) {
	sourcePath = pathpkg.Clean(strings.TrimSpace(sourcePath))
	if sourcePath == "." || sourcePath == "" {
		return "", nil, fmt.Errorf("missing directory path")
	}
	if sourcePath == "/" {
		return "", nil, fmt.Errorf("the remote root directory cannot be archived")
	}
	if archive == nil {
		return "", nil, fmt.Errorf("remote archive command is not available")
	}
	sourceInfo, err := client.Lstat(sourcePath)
	if err != nil {
		return "", nil, err
	}
	if sourceInfo.Mode()&os.ModeSymlink != 0 || !sourceInfo.IsDir() {
		return "", nil, fmt.Errorf("remote archive source is no longer a directory")
	}
	var failures []string
	for _, directory := range remoteFolderArchiveCandidateDirs(sourcePath) {
		if err := ctx.Err(); err != nil {
			return "", nil, err
		}
		archivePath, err := reserveRemoteFolderArchive(client, directory)
		if err != nil {
			failures = append(failures, directory+": "+err.Error())
			continue
		}
		if err := archive(ctx, sourcePath, archivePath); err != nil {
			_ = removeRemoteFolderArchive(client, archivePath)
			if ctxErr := ctx.Err(); ctxErr != nil {
				return "", nil, ctxErr
			}
			failures = append(failures, directory+": "+err.Error())
			continue
		}
		info, err := client.Lstat(archivePath)
		if err != nil {
			_ = removeRemoteFolderArchive(client, archivePath)
			failures = append(failures, directory+": verify archive: "+err.Error())
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() <= 0 {
			_ = removeRemoteFolderArchive(client, archivePath)
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

func remoteFolderArchiveDownloadName(requestedPath string) string {
	name := pathpkg.Base(pathpkg.Clean(strings.TrimSpace(requestedPath)))
	if name == "." || name == "/" || name == "" {
		name = "folder"
	}
	return name + remoteFolderArchiveSuffix
}

func validateDownloadArchiveIntent(archive *bool, isDirectory bool) error {
	if archive == nil {
		return nil
	}
	if *archive && !isDirectory {
		return fmt.Errorf("the selected folder changed before it could be archived")
	}
	if !*archive && isDirectory {
		return fmt.Errorf("the selected file changed before it could be downloaded")
	}
	return nil
}

type requestContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r requestContextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

type requestContextWriter struct {
	ctx context.Context
	w   io.Writer
}

func (w requestContextWriter) Write(p []byte) (int, error) {
	select {
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	default:
		return w.w.Write(p)
	}
}

func validRemoteArchiveChildName(name string) bool {
	return name != "" && name != "." && name != ".." && pathpkg.Base(name) == name && !strings.ContainsRune(name, 0)
}

func addRemoteDirectoryArchiveEntry(ctx context.Context, client *sftp.Client, writer *tar.Writer, remotePath, archiveName, temporaryArchivePath string, info os.FileInfo, depth int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if depth > 256 {
		return fmt.Errorf("folder nesting is too deep near %s", remotePath)
	}
	if pathpkg.Clean(remotePath) == pathpkg.Clean(temporaryArchivePath) {
		return nil
	}
	linkTarget := ""
	if info.Mode()&os.ModeSymlink != 0 {
		var err error
		linkTarget, err = client.ReadLink(remotePath)
		if err != nil {
			return fmt.Errorf("read symbolic link %s: %w", remotePath, err)
		}
	}
	header, err := tar.FileInfoHeader(info, linkTarget)
	if err != nil {
		return fmt.Errorf("archive metadata %s: %w", remotePath, err)
	}
	header.Name = archiveName
	header.Format = tar.FormatPAX
	if info.IsDir() && !strings.HasSuffix(header.Name, "/") {
		header.Name += "/"
	}
	if err := writer.WriteHeader(header); err != nil {
		return fmt.Errorf("write archive header %s: %w", remotePath, err)
	}
	if info.Mode().IsRegular() {
		file, err := client.Open(remotePath)
		if err != nil {
			return fmt.Errorf("open %s: %w", remotePath, err)
		}
		_, copyErr := io.CopyN(writer, requestContextReader{ctx: ctx, r: file}, info.Size())
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("archive %s: %w", remotePath, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close %s: %w", remotePath, closeErr)
		}
		return nil
	}
	if !info.IsDir() {
		return nil
	}
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		return fmt.Errorf("read directory %s: %w", remotePath, err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !validRemoteArchiveChildName(name) {
			return fmt.Errorf("invalid filename in remote directory %s", remotePath)
		}
		childPath := pathpkg.Join(remotePath, name)
		if pathpkg.Clean(childPath) == pathpkg.Clean(temporaryArchivePath) {
			continue
		}
		childInfo, err := client.Lstat(childPath)
		if err != nil {
			return fmt.Errorf("inspect %s: %w", childPath, err)
		}
		childArchiveName := pathpkg.Join(strings.TrimSuffix(archiveName, "/"), name)
		if err := addRemoteDirectoryArchiveEntry(ctx, client, writer, childPath, childArchiveName, temporaryArchivePath, childInfo, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func writeRemoteDirectoryArchiveViaSFTP(ctx context.Context, client *sftp.Client, sourcePath, archivePath string) error {
	sourceInfo, err := client.Lstat(sourcePath)
	if err != nil {
		return err
	}
	if !sourceInfo.IsDir() {
		return fmt.Errorf("remote archive source is no longer a directory")
	}
	archiveFile, err := client.OpenFile(archivePath, os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		return err
	}
	gzipWriter := gzip.NewWriter(requestContextWriter{ctx: ctx, w: archiveFile})
	tarWriter := tar.NewWriter(gzipWriter)
	archiveName := pathpkg.Base(pathpkg.Clean(sourcePath))
	resultErr := addRemoteDirectoryArchiveEntry(ctx, client, tarWriter, sourcePath, archiveName, archivePath, sourceInfo, 0)
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

func downloadRemoteDirectoryArchive(c *gin.Context, sshClient *core.SSHClient, requestedPath, sourcePath string, responseBody *ResponseBody) {
	archivePath, archiveInfo, err := prepareRemoteDirectoryArchive(c.Request.Context(), sshClient.Sftp, sourcePath, func(ctx context.Context, sourcePath, archivePath string) error {
		var commandErr error
		if remotePathWithin(archivePath, sourcePath) {
			commandErr = fmt.Errorf("temporary archive is inside the source folder")
		} else {
			commandErr = runRemoteTarArchive(ctx, sshClient.Client, sourcePath, archivePath)
		}
		if commandErr == nil {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		fallbackErr := writeRemoteDirectoryArchiveViaSFTP(ctx, sshClient.Sftp, sourcePath, archivePath)
		if fallbackErr == nil {
			return nil
		}
		return fmt.Errorf("remote tar failed (%v); SFTP compression fallback failed: %w", commandErr, fallbackErr)
	})
	if err != nil {
		responseBody.Msg = err.Error()
		status := http.StatusInternalServerError
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusRequestTimeout
		}
		c.JSON(status, responseBody)
		return
	}
	defer func() {
		if cleanupErr := removeRemoteFolderArchive(sshClient.Sftp, archivePath); cleanupErr != nil {
			log.Printf("could not remove remote folder archive %q: %v", archivePath, cleanupErr)
		}
	}()
	archiveFile, err := sshClient.Download(archivePath)
	if err != nil {
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return
	}
	defer archiveFile.Close()
	filename := remoteFolderArchiveDownloadName(requestedPath)
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	c.Header("Content-Type", "application/gzip")
	c.Header("Content-Length", strconv.FormatInt(archiveInfo.Size(), 10))
	c.Header("Cache-Control", "no-store")
	c.Header("Accept-Ranges", "none")
	c.Header("X-WebSSH-File-Size", strconv.FormatInt(archiveInfo.Size(), 10))
	c.Header("X-WebSSH-Download-Kind", "directory-archive")
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-WebSSH-File-Size, X-WebSSH-Download-Kind")
	c.Status(http.StatusOK)
	copied, copyErr := io.Copy(c.Writer, requestContextReader{ctx: c.Request.Context(), r: archiveFile})
	if copyErr == nil && copied != archiveInfo.Size() {
		copyErr = fmt.Errorf("download size changed while streaming: copied %d bytes, expected %d", copied, archiveInfo.Size())
	}
	if copyErr != nil {
		responseBody.Msg = copyErr.Error()
		_ = c.Error(copyErr)
		c.Abort()
	}
}

func DownloadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, bindErr := bindDownloadRequest(c)
	if bindErr != nil {
		responseBody.Msg = bindErr.Error()
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	path := strings.TrimSpace(request.Path)
	sshInfo := request.SSHInfo
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	if sshClient, err = decodeSSHClient(c, sshInfo); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	defer sshClient.Close()
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	fileInfo, resolvedPath, statErr := statRemoteTarget(sshClient.Sftp, path)
	if statErr != nil {
		responseBody.Msg = statErr.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	if intentErr := validateDownloadArchiveIntent(request.Archive, fileInfo.IsDir()); intentErr != nil {
		responseBody.Msg = intentErr.Error()
		c.JSON(http.StatusConflict, responseBody)
		return &responseBody
	}
	if fileInfo.IsDir() {
		downloadRemoteDirectoryArchive(c, &sshClient, path, resolvedPath, &responseBody)
		return &responseBody
	}
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	if !fileInfo.Mode().IsRegular() {
		responseBody.Msg = "only regular files can be downloaded"
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	// Open the exact target that was measured above. Using the resolved path
	// prevents the original link itself from being interpreted as a tiny file;
	// the client also verifies the final byte count before committing locally.
	if sftpFile, err := sshClient.Download(resolvedPath); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
	} else {
		defer sftpFile.Close()
		filename := pathpkg.Base(path)
		if filename == "." || filename == "/" || filename == "" {
			filename = "download"
		}
		c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
		c.Header("Content-Type", "application/octet-stream")
		c.Header("Content-Length", strconv.FormatInt(fileInfo.Size(), 10))
		c.Header("Cache-Control", "no-store")
		c.Header("Accept-Ranges", "none")
		c.Header("X-WebSSH-File-Size", strconv.FormatInt(fileInfo.Size(), 10))
		c.Header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-WebSSH-File-Size")
		c.Status(http.StatusOK)
		copied, copyErr := io.Copy(c.Writer, sftpFile)
		if copyErr == nil && copied != fileInfo.Size() {
			copyErr = fmt.Errorf("download size changed while streaming: copied %d bytes, expected %d", copied, fileInfo.Size())
		}
		if copyErr != nil {
			responseBody.Msg = copyErr.Error()
			_ = c.Error(copyErr)
			c.Abort()
		}
	}
	return &responseBody
}

func RemoteDownloadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	readTimer := time.AfterFunc(30*time.Second, func() { _ = c.Request.Body.Close() })
	sshInfo := c.PostForm("sshInfo")
	rawURL := strings.TrimSpace(c.PostForm("url"))
	dir := strings.TrimSpace(c.DefaultPostForm("path", ""))
	filename := sanitizeRemoteFilename(c.PostForm("filename"))
	readTimer.Stop()
	if rawURL == "" {
		responseBody.Msg = "missing remote url"
		return &responseBody
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		responseBody.Msg = "invalid remote url"
		return &responseBody
	}
	if err := validateRemoteURL(c.Request.Context(), parsedURL); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	if sshClient, err = decodeSSHClient(c, sshInfo); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	if dir == "" {
		dir = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	if err := sshClient.Mkdirs(dir); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	httpClient := newRemoteDownloadClient()
	req, err := newRemoteDownloadRequest(c.Request.Context(), rawURL)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody.Msg = fmt.Sprintf("remote server returned %s", resp.Status)
		return &responseBody
	}
	maxBytes := remoteDownloadMaxBytes()
	if resp.ContentLength > maxBytes {
		responseBody.Msg = fmt.Sprintf("remote file exceeds %d bytes", maxBytes)
		return &responseBody
	}
	if filename == "" {
		filename = filenameFromDisposition(resp.Header.Get("Content-Disposition"))
	}
	if filename == "" {
		urlFilename, _ := url.PathUnescape(pathpkg.Base(resp.Request.URL.EscapedPath()))
		filename = sanitizeRemoteFilename(urlFilename)
	}
	if filename == "" || filename == "." || filename == "/" {
		filename = fmt.Sprintf("download-%d", time.Now().Unix())
	}
	dstPath := pathpkg.Join(dir, filename)
	tmpPath, dstFile, err := createRemoteDownloadTempFile(sshClient.Sftp, dir)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	closed := false
	defer func() {
		if !closed {
			_ = dstFile.Close()
		}
		_ = sshClient.Sftp.Remove(tmpPath)
	}()
	limited := &io.LimitedReader{R: resp.Body, N: maxBytes + 1}
	written, copyErr := io.Copy(dstFile, limited)
	if copyErr != nil || written > maxBytes {
		if copyErr != nil {
			fmt.Println(copyErr)
			responseBody.Msg = copyErr.Error()
		} else {
			responseBody.Msg = fmt.Sprintf("remote file exceeds %d bytes", maxBytes)
		}
		return &responseBody
	}
	if err := dstFile.Close(); err != nil {
		closed = true
		responseBody.Msg = err.Error()
		return &responseBody
	}
	closed = true
	if err := replaceRemoteFile(sshClient.Sftp, tmpPath, dstPath); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = gin.H{"path": dstPath, "filename": filename}
	return &responseBody
}

func replaceRemoteFile(client *sftp.Client, oldPath, newPath string) error {
	if _, supported := client.HasExtension("posix-rename@openssh.com"); supported {
		if err := client.PosixRename(oldPath, newPath); err == nil {
			return nil
		} else if !isSFTPUnsupported(err) {
			return err
		}
	}
	// Older SFTP servers do not advertise posix-rename.  Fall back only when
	// that extension is absent/unsupported. Some v3 servers replace an existing
	// destination with the standard RENAME packet, while stricter ones reject
	// it. We deliberately keep the destination intact on rejection instead of
	// deleting/truncating it first: atomic replacement is required for editor
	// saves and remote downloads, so failure is safer than a data-loss window.
	return client.Rename(oldPath, newPath)
}

func isSFTPUnsupported(err error) bool {
	return isSFTPStatus(err, uint32(sftp.ErrSSHFxOpUnsupported))
}

func isSFTPStatus(err error, code uint32) bool {
	var statusErr *sftp.StatusError
	return errors.As(err, &statusErr) && statusErr.Code == code
}

func newRemoteDownloadRequest(ctx context.Context, rawURL string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "webssh-remote-download/1.0")
	return req, nil
}

func createRemoteDownloadTempFile(client *sftp.Client, dir string) (string, *sftp.File, error) {
	for attempt := 0; attempt < 10; attempt++ {
		randomBytes := make([]byte, 12)
		if _, err := rand.Read(randomBytes); err != nil {
			return "", nil, fmt.Errorf("create download temp name: %w", err)
		}
		tmpPath := pathpkg.Join(dir, ".webssh-download-"+hex.EncodeToString(randomBytes)+".tmp")
		file, err := client.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
		if err == nil {
			return tmpPath, file, nil
		}
		if !os.IsExist(err) {
			return "", nil, err
		}
	}
	return "", nil, fmt.Errorf("unable to create a unique download temp file")
}

func filenameFromDisposition(value string) string {
	if value == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	if filename := sanitizeRemoteFilename(params["filename*"]); filename != "" {
		return filename
	}
	return sanitizeRemoteFilename(params["filename"])
}

func sanitizeRemoteFilename(filename string) string {
	filename = strings.TrimSpace(filename)
	filename = strings.ReplaceAll(filename, "\\", "/")
	filename = pathpkg.Base(filename)
	filename = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, filename)
	filename = strings.TrimSpace(filename)
	if filename == "" || filename == "." || filename == ".." || filename == "/" {
		return ""
	}
	return filename
}

func UploadProgressWs(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer wsConn.Close()
	id := c.Query("id")
	if strings.TrimSpace(id) == "" {
		responseBody.Msg = "missing upload id"
		return &responseBody
	}
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	waitTimer := time.NewTimer(30 * time.Second)
	defer waitTimer.Stop()
	var ready bool
	for {
		var total int64
		var found bool
		core.WcMu.Lock()
		if counter := core.WcMap[id]; counter != nil {
			total = atomic.LoadInt64(&counter.Total)
			found = true
		}
		core.WcMu.Unlock()
		if found {
			ready = true
			if err := wsConn.WriteMessage(1, []byte(strconv.FormatInt(total, 10))); err != nil {
				responseBody.Msg = err.Error()
				return &responseBody
			}
			if !waitTimer.Stop() {
				select {
				case <-waitTimer.C:
				default:
				}
			}
			waitTimer.Reset(30 * time.Second)
		} else if ready {
			return &responseBody
		}
		select {
		case <-ticker.C:
		case <-waitTimer.C:
			if !ready {
				responseBody.Msg = "upload progress timeout"
			}
			return &responseBody
		}
	}
}

func readSFTPDirectoryForList(client *core.SSHClient, requestedPath string) (string, string, []os.FileInfo, error) {
	path := strings.TrimSpace(requestedPath)
	home := ""
	if path == "" {
		if client.Username == "root" {
			path = "/"
			home = "/root"
		} else {
			home = detectHomeDir(client.Sftp, client.Username)
			path = home
		}
	} else {
		path = pathpkg.Clean(path)
		if path == "." {
			path = "/"
		}
		if path == "/" && client.Username != "root" {
			home = detectHomeDir(client.Sftp, client.Username)
			if home != "/" {
				path = home
			}
		} else if client.Username == "root" {
			home = "/root"
		}
	}
	files, err := client.Sftp.ReadDir(path)
	return path, home, files, err
}

func FileList(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if _, err := normalizeSFTPSessionID(request.SessionID); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	lease, err := acquireSFTPSessionLease(c, request.SessionID, request.SSHInfo, sshClient)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	path, home, files, err := readSFTPDirectoryForList(lease.Client, request.Path)
	if err != nil && lease.isPersistent && sftpSessionConnectionBroken(err) {
		lease.Release(true)
		lease, err = acquireSFTPSessionLease(c, request.SessionID, request.SSHInfo, sshClient)
		if err == nil {
			path, home, files, err = readSFTPDirectoryForList(lease.Client, request.Path)
		}
	}
	if lease != nil {
		defer lease.Release(err != nil && sftpSessionConnectionBroken(err))
	}
	if err != nil {
		if strings.Contains(err.Error(), "exist") {
			responseBody.Msg = fmt.Sprintf("Directory %s: no such file or directory", path)
		} else {
			responseBody.Msg = err.Error()
		}
		return &responseBody
	}
	var (
		fileList        fileSplice
		editorMaxBytes  = remoteEditorMaxBytes()
		previewMaxBytes = remotePreviewMaxBytes()
	)
	for _, mFile := range files {
		if isRemoteFolderArchiveName(mFile.Name()) {
			continue
		}
		info := mFile
		isSymlink := mFile.Mode()&os.ModeSymlink != 0
		resolveErr := error(nil)
		if isSymlink {
			resolved, statErr := lease.Client.Sftp.Stat(pathpkg.Join(path, mFile.Name()))
			resolveErr = statErr
			if resolveErr == nil {
				info = resolved
			}
		}
		isDir := resolveErr == nil && info.IsDir()
		previewSpec, previewTypeKnown := remotePreviewSpecForName(mFile.Name())
		mediaBinary := previewTypeKnown && previewSpec.Kind != "" && !strings.EqualFold(pathpkg.Ext(mFile.Name()), ".svg")
		editable := resolveErr == nil && info.Mode().IsRegular() && info.Size() <= editorMaxBytes && !mediaBinary
		previewable := resolveErr == nil && info.Mode().IsRegular() && previewTypeKnown && info.Size() <= previewMaxBytes
		downloadable := resolveErr == nil && (isDir || info.Mode().IsRegular())
		editReason := ""
		if !isDir && !editable {
			switch {
			case resolveErr != nil:
				editReason = "符号链接目标不可访问"
			case !info.Mode().IsRegular():
				editReason = "仅支持普通文件"
			case mediaBinary:
				editReason = "媒体文件请使用在线预览"
			case info.Size() > editorMaxBytes:
				editReason = fmt.Sprintf("文件超过在线编辑上限 %s", Bytefmt(uint64(editorMaxBytes)))
			}
		}
		previewReason := ""
		if previewTypeKnown && !previewable {
			switch {
			case resolveErr != nil:
				previewReason = "符号链接目标不可访问"
			case !info.Mode().IsRegular():
				previewReason = "仅支持预览普通文件"
			case info.Size() > previewMaxBytes:
				previewReason = fmt.Sprintf("文件超过在线预览上限 %s", Bytefmt(uint64(previewMaxBytes)))
			}
		}
		downloadReason := ""
		if !downloadable {
			switch {
			case resolveErr != nil:
				downloadReason = "符号链接目标不可访问"
			case !info.Mode().IsRegular():
				downloadReason = "仅支持下载普通文件或文件夹"
			}
		}
		sizeBytes := info.Size()
		if resolveErr != nil {
			sizeBytes = 0
		}
		if sizeBytes < 0 {
			sizeBytes = 0
		}
		file := File{
			Name:           mFile.Name(),
			IsDir:          isDir,
			IsSymlink:      isSymlink,
			Editable:       editable,
			EditReason:     editReason,
			Previewable:    previewable,
			PreviewKind:    previewSpec.Kind,
			PreviewMime:    previewSpec.MIME,
			PreviewReason:  previewReason,
			Downloadable:   downloadable,
			DownloadReason: downloadReason,
			SizeBytes:      sizeBytes,
			Size:           formatRemoteFileSize(sizeBytes, isDir),
			ModifyTime:     info.ModTime().Format("2006-01-02 15:04:05"),
		}
		fileList = append(fileList, file)
	}
	sort.Stable(fileList)
	responseBody.Data = gin.H{
		"list": fileList,
		"home": home,
		"path": path,
	}
	return &responseBody
}

func uploadMaxBytes() int64 {
	const defaultLimit = int64(1 << 30)
	raw := strings.TrimSpace(os.Getenv("WEBSSH_UPLOAD_MAX_BYTES"))
	if raw == "" {
		return defaultLimit
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1<<20 {
		return defaultLimit
	}
	return value
}

func detectHomeDir(sftpClient *sftp.Client, username string) string {
	if wd, err := sftpClient.Getwd(); err == nil && wd != "" {
		return wd
	}
	if username == "root" {
		return "/root"
	}
	potentialHome := fmt.Sprintf("/usr/home/%s", username)
	if _, err := sftpClient.Stat(potentialHome); err == nil {
		return potentialHome
	}
	potentialHome = fmt.Sprintf("/home/%s", username)
	if _, err := sftpClient.Stat(potentialHome); err == nil {
		return potentialHome
	}
	return "/home"
}
