package controller

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
)

type File struct {
	Name       string
	Size       string
	SizeBytes  int64
	ModifyTime string
	IsDir      bool
	IsSymlink  bool
	Editable   bool
	EditReason string
}

type fileRequest struct {
	SSHInfo string `json:"sshInfo"`
	Path    string `json:"path"`
}

type fileSaveRequest struct {
	SSHInfo string `json:"sshInfo"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Version string `json:"version"`
	Create  bool   `json:"create"`
}

type remoteFileSnapshot struct {
	Content  string
	Version  string
	Size     int64
	Mode     os.FileMode
	Modified time.Time
	Stat     *sftp.FileStat
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

func remoteFileVersion(info os.FileInfo, content []byte) string {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%d\n%d\n%o\n", info.Size(), info.ModTime().UnixNano(), info.Mode())
	_, _ = hash.Write(content)
	return hex.EncodeToString(hash.Sum(nil))
}

func readRemoteTextFile(client *sftp.Client, path string, maxBytes int64) (remoteFileSnapshot, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return remoteFileSnapshot{}, fmt.Errorf("missing path")
	}
	// Stat follows symbolic links.  Editing through a link would make the
	// temporary-file rename replace the link itself (or, depending on the
	// server, unexpectedly modify a different target).  Keep the editor
	// deliberately limited to a concrete regular file.
	lstat, err := client.Lstat(path)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if lstat.Mode()&os.ModeSymlink != 0 {
		return remoteFileSnapshot{}, fmt.Errorf("symbolic links cannot be edited")
	}
	info, err := client.Stat(path)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if !info.Mode().IsRegular() {
		return remoteFileSnapshot{}, fmt.Errorf("only regular files can be edited")
	}
	if info.Size() > maxBytes {
		return remoteFileSnapshot{}, fmt.Errorf("file is too large to edit (maximum %s)", Bytefmt(uint64(maxBytes)))
	}
	file, err := client.Open(path)
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
		Content:  string(content),
		Version:  remoteFileVersion(info, content),
		Size:     int64(len(content)),
		Mode:     info.Mode(),
		Modified: info.ModTime(),
		Stat:     cloneSFTPFileStat(info),
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
	if err := validateRemoteTextContent(content, maxBytes, "save", "saved"); err != nil {
		return remoteFileSnapshot{}, err
	}
	current, err := readRemoteTextFile(client, path, maxBytes)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
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
	tmpPath := pathpkg.Join(pathpkg.Dir(path), ".webssh-edit-"+hex.EncodeToString(randomBytes)+".tmp")
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
	if latest.Version != expectedVersion {
		return remoteFileSnapshot{}, fmt.Errorf("the remote file changed while it was being saved; reload it before trying again")
	}
	// Re-check the link type immediately before the commit.  This closes the
	// most important replace-via-link race without weakening the optimistic
	// version check above.
	latestLstat, err := client.Lstat(path)
	if err != nil {
		return remoteFileSnapshot{}, err
	}
	if latestLstat.Mode()&os.ModeSymlink != 0 || !latestLstat.Mode().IsRegular() {
		return remoteFileSnapshot{}, fmt.Errorf("the remote file is no longer a regular file")
	}
	if err := replaceRemoteFile(client, tmpPath, path); err != nil {
		return remoteFileSnapshot{}, err
	}
	committed = true
	return readRemoteTextFile(client, path, maxBytes)
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
		return createRemoteTextFile(client, request.Path, []byte(request.Content), maxBytes)
	}
	return writeRemoteTextFile(client, request.Path, []byte(request.Content), request.Version, maxBytes)
}

func remoteSnapshotData(path string, snapshot remoteFileSnapshot, maxBytes int64) gin.H {
	return gin.H{
		"path":       path,
		"name":       pathpkg.Base(path),
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
	snapshot, err := saveRemoteTextFileWithLock(c.Request.Context(), remoteEditorTargetKey(sshClient, path), sshClient.Sftp, request, maxBytes)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = remoteSnapshotData(path, snapshot, maxBytes)
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
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &sshClient)
	defer stopCancellation()
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	fileInfo, resolvedPath, statErr := statRemoteTarget(sshClient.Sftp, path)
	if statErr != nil {
		responseBody.Msg = statErr.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	if fileInfo.IsDir() {
		responseBody.Msg = "cannot download a directory"
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
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
	var statusErr *sftp.StatusError
	return errors.As(err, &statusErr) && statusErr.FxCode() == sftp.ErrSSHFxOpUnsupported
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

func FileList(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	path := request.Path
	sshInfo := request.SSHInfo
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, sshInfo)
	if err != nil {
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
	home := detectHomeDir(sshClient.Sftp, sshClient.Username)
	if path == "/" && home != "/" && sshClient.Username != "root" {
		path = home
	}
	if path == "" {
		if sshClient.Username == "root" {
			path = "/"
		} else {
			path = home
		}
	}
	files, err := sshClient.Sftp.ReadDir(path)
	if err != nil {
		if strings.Contains(err.Error(), "exist") {
			responseBody.Msg = fmt.Sprintf("Directory %s: no such file or directory", path)
		} else {
			responseBody.Msg = err.Error()
		}
		return &responseBody
	}
	var (
		fileList       fileSplice
		editorMaxBytes = remoteEditorMaxBytes()
	)
	for _, mFile := range files {
		info := mFile
		isSymlink := mFile.Mode()&os.ModeSymlink != 0
		resolveErr := error(nil)
		if isSymlink {
			resolved, _, statErr := statRemoteTarget(sshClient.Sftp, pathpkg.Join(path, mFile.Name()))
			resolveErr = statErr
			if resolveErr == nil {
				info = resolved
			}
		}
		isDir := resolveErr == nil && info.IsDir()
		editable := !isSymlink && resolveErr == nil && info.Mode().IsRegular() && info.Size() <= editorMaxBytes
		editReason := ""
		if !isDir && !editable {
			switch {
			case resolveErr != nil:
				editReason = "符号链接目标不可访问"
			case isSymlink:
				editReason = "符号链接不支持在线编辑"
			case !info.Mode().IsRegular():
				editReason = "仅支持普通文件"
			case info.Size() > editorMaxBytes:
				editReason = fmt.Sprintf("文件超过在线编辑上限 %s", Bytefmt(uint64(editorMaxBytes)))
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
			Name:       mFile.Name(),
			IsDir:      isDir,
			IsSymlink:  isSymlink,
			Editable:   editable,
			EditReason: editReason,
			SizeBytes:  sizeBytes,
			Size:       formatRemoteFileSize(sizeBytes, isDir),
			ModifyTime: info.ModTime().Format("2006-01-02 15:04:05"),
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
