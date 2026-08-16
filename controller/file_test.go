package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	pathpkg "path"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

type testFileInfo struct {
	name string
	size int64
}

func (f testFileInfo) Name() string       { return f.name }
func (f testFileInfo) Size() int64        { return f.size }
func (f testFileInfo) Mode() os.FileMode  { return 0o644 }
func (f testFileInfo) ModTime() time.Time { return time.Unix(123, 0) }
func (f testFileInfo) IsDir() bool        { return false }
func (f testFileInfo) Sys() any           { return nil }

func TestFormatRemoteFileSize(t *testing.T) {
	tests := []struct {
		name  string
		size  int64
		isDir bool
		want  string
	}{
		{name: "negative file size", size: -1, want: "0B"},
		{name: "negative directory size", size: -1, isDir: true, want: "0"},
		{name: "file size", size: 1024, want: "1K"},
		{name: "directory size", size: 1024, isDir: true, want: "1024"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := formatRemoteFileSize(test.size, test.isDir); got != test.want {
				t.Fatalf("formatRemoteFileSize(%d, %t) = %q, want %q", test.size, test.isDir, got, test.want)
			}
		})
	}
}

func runUploadMultipartTest(t *testing.T, build func(*multipart.Writer)) *ResponseBody {
	t.Helper()
	uploadSlots.Lock()
	uploadSlots.Total = 0
	uploadSlots.Clients = make(map[string]int)
	uploadSlots.Unlock()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	build(writer)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/upload", &body)
	ctx.Request.Header.Set("Content-Type", writer.FormDataContentType())
	return UploadFile(ctx)
}

func TestUploadRejectsUnknownAndOversizedMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := runUploadMultipartTest(t, func(writer *multipart.Writer) {
		if err := writer.WriteField("unexpected", "value"); err != nil {
			t.Fatal(err)
		}
	})
	if response.Msg != "unknown upload field" {
		t.Fatalf("unknown upload field response = %q", response.Msg)
	}

	response = runUploadMultipartTest(t, func(writer *multipart.Writer) {
		if err := writer.WriteField("sshInfo", strings.Repeat("x", uploadMetadataMaxBytes+1)); err != nil {
			t.Fatal(err)
		}
	})
	if response.Msg != "upload metadata is too large" {
		t.Fatalf("oversized upload metadata response = %q", response.Msg)
	}
}

func TestUploadRequiresMetadataBeforeFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := runUploadMultipartTest(t, func(writer *multipart.Writer) {
		part, err := writer.CreateFormFile("file", "test.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte("test")); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(response.Msg, "metadata must appear before") {
		t.Fatalf("file-first upload response = %q", response.Msg)
	}
}

func TestUploadCheckedValidatesBeforeRemoteCommit(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	localDir := t.TempDir()
	destinationLocal := filepath.Join(localDir, "uploaded.txt")
	destination := editorTestRemotePath(destinationLocal)
	sshClient := core.NewSSHClient()
	sshClient.Sftp = client
	validationErr := errors.New("multipart has trailing fields")
	if err := sshClient.UploadChecked(context.Background(), strings.NewReader("not committed"), "", destination, func() error {
		return validationErr
	}); !errors.Is(err, validationErr) {
		t.Fatalf("UploadChecked() error = %v, want validation error", err)
	}
	if _, err := os.Stat(destinationLocal); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("destination exists after failed validation: %v", err)
	}
	entries, err := os.ReadDir(localDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".webssh-upload-") {
			t.Fatalf("temporary upload remained after failed validation: %s", entry.Name())
		}
	}

	if err := sshClient.UploadChecked(context.Background(), strings.NewReader("committed"), "", destination, nil); err != nil {
		t.Fatalf("UploadChecked() success error = %v", err)
	}
	content, err := os.ReadFile(destinationLocal)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "committed" {
		t.Fatalf("uploaded content = %q", content)
	}
}

func TestBindDownloadRequestReadsDirectoryArchiveIntent(t *testing.T) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/download", strings.NewReader(`{"sshInfo":"encoded","path":"/srv/logs","archive":true}`))
	ctx.Request.Header.Set("Content-Type", "application/json")

	request, err := bindDownloadRequest(ctx)
	if err != nil {
		t.Fatalf("bindDownloadRequest() error = %v", err)
	}
	if request.Archive == nil || !*request.Archive {
		t.Fatal("directory archive intent was not preserved")
	}
	if request.Path != "/srv/logs" {
		t.Fatalf("request path = %q, want /srv/logs", request.Path)
	}
}

func TestBindDownloadRequestReadsFileIntentFromLegacyForm(t *testing.T) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/download", strings.NewReader("sshInfo=encoded&path=%2Fsrv%2Ffile.txt&archive=false"))
	ctx.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	request, err := bindDownloadRequest(ctx)
	if err != nil {
		t.Fatalf("bindDownloadRequest() error = %v", err)
	}
	if request.Archive == nil || *request.Archive {
		t.Fatal("file download intent was not preserved")
	}
	if request.Path != "/srv/file.txt" {
		t.Fatalf("request path = %q, want /srv/file.txt", request.Path)
	}
}

func TestValidateDownloadArchiveIntentRejectsTargetTypeChanges(t *testing.T) {
	archive := true
	file := false
	if err := validateDownloadArchiveIntent(&archive, true); err != nil {
		t.Fatalf("directory intent rejected a directory: %v", err)
	}
	if err := validateDownloadArchiveIntent(&file, false); err != nil {
		t.Fatalf("file intent rejected a regular file: %v", err)
	}
	if err := validateDownloadArchiveIntent(&archive, false); err == nil || !strings.Contains(err.Error(), "folder changed") {
		t.Fatalf("directory-to-file change error = %v", err)
	}
	if err := validateDownloadArchiveIntent(&file, true); err == nil || !strings.Contains(err.Error(), "file changed") {
		t.Fatalf("file-to-directory change error = %v", err)
	}
	if err := validateDownloadArchiveIntent(nil, true); err != nil {
		t.Fatalf("legacy request without an intent should remain compatible: %v", err)
	}
}

func TestStreamDownloadResponseStopsAtAuthorizedSize(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/file/download", nil)

	written, err := streamDownloadResponse(ctx, context.Background(), strings.NewReader("abcdef"), 3)
	if err != nil {
		t.Fatalf("streamDownloadResponse() error = %v", err)
	}
	if written != 3 || recorder.Body.String() != "abc" {
		t.Fatalf("streamed %d bytes with body %q, want 3 bytes and %q", written, recorder.Body.String(), "abc")
	}
}

func TestValidateRemoteDownloadByteCount(t *testing.T) {
	if err := validateRemoteDownloadByteCount(-1, 7); err != nil {
		t.Fatalf("unknown content length was rejected: %v", err)
	}
	if err := validateRemoteDownloadByteCount(7, 7); err != nil {
		t.Fatalf("matching content length was rejected: %v", err)
	}
	if err := validateRemoteDownloadByteCount(7, 3); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("short remote download error = %v", err)
	}
}

func TestStatRemoteTargetResolvesRelativeSymlinkChains(t *testing.T) {
	dir := t.TempDir()
	targetPath := dir + string(os.PathSeparator) + "target.bin"
	firstLink := dir + string(os.PathSeparator) + "first.link"
	secondLink := dir + string(os.PathSeparator) + "second.link"
	content := strings.Repeat("download-size-check\n", 4096)
	if err := os.WriteFile(targetPath, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	client := newEditorTestSFTPClientWithHandler(t, editorTestHandler{readlinks: map[string]string{
		cleanEditorTestPath(editorTestRemotePath(firstLink)):  "target.bin",
		cleanEditorTestPath(editorTestRemotePath(secondLink)): "first.link",
	}})

	info, resolved, err := statRemoteTarget(client, editorTestRemotePath(secondLink))
	if err != nil {
		t.Fatalf("statRemoteTarget() error = %v", err)
	}
	if info.Size() != int64(len(content)) {
		t.Fatalf("resolved size = %d, want %d", info.Size(), len(content))
	}
	if pathpkg.Base(resolved) != "target.bin" {
		t.Fatalf("resolved path = %q, want target.bin", resolved)
	}
}

func TestStatRemoteTargetRejectsSymlinkLoopWithoutOSPrivileges(t *testing.T) {
	dir := t.TempDir()
	firstLink := dir + string(os.PathSeparator) + "first.link"
	secondLink := dir + string(os.PathSeparator) + "second.link"
	client := newEditorTestSFTPClientWithHandler(t, editorTestHandler{readlinks: map[string]string{
		cleanEditorTestPath(editorTestRemotePath(firstLink)):  "second.link",
		cleanEditorTestPath(editorTestRemotePath(secondLink)): "first.link",
	}})

	if _, _, err := statRemoteTarget(client, editorTestRemotePath(firstLink)); err == nil || !strings.Contains(err.Error(), "loop") {
		t.Fatalf("statRemoteTarget() loop error = %v", err)
	}
}

func TestValidateRemoteTextContent(t *testing.T) {
	tests := []struct {
		name       string
		content    []byte
		maxBytes   int64
		action     string
		pastAction string
		wantErr    string
	}{
		{name: "valid utf8", content: []byte("hello\n世界\n"), maxBytes: 64, action: "edit", pastAction: "edited"},
		{name: "size limit", content: []byte("12345"), maxBytes: 4, action: "save", pastAction: "saved", wantErr: "too large"},
		{name: "nul byte", content: []byte{'a', 0, 'b'}, maxBytes: 64, action: "save", pastAction: "saved", wantErr: "UTF-8 text"},
		{name: "invalid utf8", content: []byte{0xff, 0xfe}, maxBytes: 64, action: "edit", pastAction: "edited", wantErr: "UTF-8 text"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRemoteTextContent(test.content, test.maxBytes, test.action, test.pastAction)
			if test.wantErr == "" && err != nil {
				t.Fatalf("validateRemoteTextContent() error = %v", err)
			}
			if test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("validateRemoteTextContent() error = %v, want substring %q", err, test.wantErr)
			}
		})
	}
}

func TestRemoteFileVersionChangesWithContent(t *testing.T) {
	info := testFileInfo{name: "config", size: 3}
	first := remoteFileVersion(info, []byte("one"))
	second := remoteFileVersion(info, []byte("two"))
	if first == second {
		t.Fatal("remoteFileVersion did not change when content changed")
	}
	if first != remoteFileVersion(info, []byte("one")) {
		t.Fatal("remoteFileVersion is not deterministic")
	}
}

func TestRemoteEditorRequestBodyLimitAllowsJSONExpansion(t *testing.T) {
	t.Setenv("WEBSSH_EDITOR_MAX_BYTES", "2097152")
	if got, min := RemoteEditorRequestBodyLimit(), int64(6*2097152); got <= min {
		t.Fatalf("RemoteEditorRequestBodyLimit() = %d, want more than %d", got, min)
	}
}

func TestRemoteEditorMaxBytesRejectsUnsafeConfiguration(t *testing.T) {
	t.Setenv("WEBSSH_EDITOR_MAX_BYTES", "1073741824")
	if got := remoteEditorMaxBytes(); got != defaultRemoteEditorMaxBytes {
		t.Fatalf("remoteEditorMaxBytes() = %d, want default %d", got, defaultRemoteEditorMaxBytes)
	}
}

func TestRemotePreviewTypesAreExplicitAndCaseInsensitive(t *testing.T) {
	tests := []struct {
		name string
		kind string
		mime string
	}{
		{name: "photo.JPG", kind: "image", mime: "image/jpeg"},
		{name: "icon.ico", kind: "image", mime: "image/x-icon"},
		{name: "vector.svg", kind: "image", mime: "image/svg+xml"},
		{name: "clip.WEBM", kind: "video", mime: "video/webm"},
		{name: "movie.mp4", kind: "video", mime: "video/mp4"},
	}
	for _, test := range tests {
		spec, ok := remotePreviewSpecForName(test.name)
		if !ok || spec.Kind != test.kind || spec.MIME != test.mime {
			t.Fatalf("remotePreviewSpecForName(%q) = %#v, %t", test.name, spec, ok)
		}
	}
	if _, ok := remotePreviewSpecForName("secret.key"); ok {
		t.Fatal("an unsupported extension was marked previewable")
	}
}

func TestRemotePreviewMaxBytesRejectsUnsafeConfiguration(t *testing.T) {
	t.Setenv("WEBSSH_PREVIEW_MAX_BYTES", "2147483648")
	if got := remotePreviewMaxBytes(); got != defaultRemotePreviewMaxBytes {
		t.Fatalf("remotePreviewMaxBytes() = %d, want default %d", got, defaultRemotePreviewMaxBytes)
	}
	t.Setenv("WEBSSH_PREVIEW_MAX_BYTES", "67108864")
	if got := remotePreviewMaxBytes(); got != 64<<20 {
		t.Fatalf("remotePreviewMaxBytes() = %d, want %d", got, 64<<20)
	}
}

func TestResolveRemotePreviewTargetChecksTypeAndSize(t *testing.T) {
	dir := t.TempDir()
	imagePath := pathpkg.Join(dir, "preview.png")
	content := []byte("\x89PNG\r\n\x1a\npreview")
	if err := os.WriteFile(imagePath, content, 0o640); err != nil {
		t.Fatal(err)
	}
	client := newEditorTestSFTPClientWithHandler(t, editorTestHandler{})
	info, resolved, spec, err := resolveRemotePreviewTarget(client, editorTestRemotePath(imagePath), int64(len(content)))
	if err != nil {
		t.Fatalf("resolveRemotePreviewTarget() error = %v", err)
	}
	if info.Size() != int64(len(content)) || pathpkg.Base(resolved) != "preview.png" || spec.Kind != "image" {
		t.Fatalf("resolved preview = size %d, path %q, spec %#v", info.Size(), resolved, spec)
	}
	if _, _, _, err := resolveRemotePreviewTarget(client, editorTestRemotePath(imagePath), int64(len(content)-1)); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized preview error = %v", err)
	}
	if _, _, _, err := resolveRemotePreviewTarget(client, strings.TrimSuffix(editorTestRemotePath(imagePath), ".png")+".txt", int64(len(content))); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatalf("unsupported preview error = %v", err)
	}
}

type editorTestLister []os.FileInfo

func (l editorTestLister) ListAt(dst []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(dst, l[offset:])
	if n < len(dst) {
		return n, io.EOF
	}
	return n, nil
}

type editorTestSymlinkInfo struct {
	name   string
	target string
}

func (f editorTestSymlinkInfo) Name() string       { return f.name }
func (f editorTestSymlinkInfo) Size() int64        { return int64(len(f.target)) }
func (f editorTestSymlinkInfo) Mode() os.FileMode  { return os.ModeSymlink | 0o777 }
func (f editorTestSymlinkInfo) ModTime() time.Time { return time.Unix(123, 0) }
func (f editorTestSymlinkInfo) IsDir() bool        { return false }
func (f editorTestSymlinkInfo) Sys() any           { return nil }

type editorTestHandler struct {
	readlinks  map[string]string
	failWrites bool
}

type editorTestFailingFile struct {
	*os.File
}

func (file *editorTestFailingFile) WriteAt(buffer []byte, offset int64) (int, error) {
	if len(buffer) == 0 {
		return 0, errors.New("forced write failure")
	}
	count := len(buffer) / 2
	if count < 1 {
		count = 1
	}
	written, _ := file.File.WriteAt(buffer[:count], offset)
	return written, errors.New("forced write failure")
}

func cleanEditorTestPath(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "/"
	}
	name = strings.ReplaceAll(name, "\\", "/")
	if len(name) >= 3 && name[0] == '/' && name[2] == ':' {
		name = name[1:]
	}
	return strings.ReplaceAll(name, "/", string(os.PathSeparator))
}

func editorTestRemotePath(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if len(name) >= 2 && name[1] == ':' {
		return "/" + name
	}
	return name
}

func (editorTestHandler) Fileread(request *sftp.Request) (io.ReaderAt, error) {
	return os.Open(cleanEditorTestPath(request.Filepath))
}

func (h editorTestHandler) Filewrite(request *sftp.Request) (io.WriterAt, error) {
	return h.OpenFile(request)
}

func (h editorTestHandler) OpenFile(request *sftp.Request) (sftp.WriterAtReaderAt, error) {
	flags := request.Pflags()
	openFlags := 0
	if flags.Read && flags.Write {
		openFlags = os.O_RDWR
	} else if flags.Write {
		openFlags = os.O_WRONLY
	} else {
		openFlags = os.O_RDONLY
	}
	if flags.Creat {
		openFlags |= os.O_CREATE
	}
	if flags.Trunc {
		openFlags |= os.O_TRUNC
	}
	if flags.Excl {
		openFlags |= os.O_EXCL
	}
	if flags.Append {
		openFlags |= os.O_APPEND
	}
	file, err := os.OpenFile(cleanEditorTestPath(request.Filepath), openFlags, 0o644)
	if err != nil {
		return nil, err
	}
	if h.failWrites && flags.Write {
		return &editorTestFailingFile{File: file}, nil
	}
	return file, nil
}

func (editorTestHandler) Filecmd(request *sftp.Request) error {
	name := cleanEditorTestPath(request.Filepath)
	switch request.Method {
	case "Setstat":
		attrs := request.Attributes()
		flags := request.AttrFlags()
		if flags.Size {
			if err := os.Truncate(name, int64(attrs.Size)); err != nil {
				return err
			}
		}
		if flags.UidGid {
			if err := os.Chown(name, int(attrs.UID), int(attrs.GID)); err != nil {
				return err
			}
		}
		if flags.Permissions {
			if err := os.Chmod(name, attrs.FileMode()); err != nil {
				return err
			}
		}
		if flags.Acmodtime {
			return os.Chtimes(name, attrs.AccessTime(), attrs.ModTime())
		}
		return nil
	case "Rename":
		return os.Rename(name, cleanEditorTestPath(request.Target))
	case "Remove":
		return os.Remove(name)
	case "Mkdir":
		return os.Mkdir(name, 0o755)
	case "Rmdir":
		return os.Remove(name)
	}
	return os.ErrInvalid
}

func (editorTestHandler) PosixRename(request *sftp.Request) error {
	return os.Rename(cleanEditorTestPath(request.Filepath), cleanEditorTestPath(request.Target))
}

func (editorTestHandler) Filelist(request *sftp.Request) (sftp.ListerAt, error) {
	name := cleanEditorTestPath(request.Filepath)
	switch request.Method {
	case "Stat":
		info, err := os.Stat(name)
		if err != nil {
			return nil, err
		}
		return editorTestLister{info}, nil
	case "List":
		entries, err := os.ReadDir(name)
		if err != nil {
			return nil, err
		}
		infos := make(editorTestLister, 0, len(entries))
		for _, entry := range entries {
			info, infoErr := entry.Info()
			if infoErr != nil {
				return nil, infoErr
			}
			infos = append(infos, info)
		}
		return infos, nil
	}
	return nil, os.ErrInvalid
}

func (h editorTestHandler) Lstat(request *sftp.Request) (sftp.ListerAt, error) {
	name := cleanEditorTestPath(request.Filepath)
	if target, ok := h.readlinks[name]; ok {
		return editorTestLister{editorTestSymlinkInfo{name: pathpkg.Base(request.Filepath), target: target}}, nil
	}
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	return editorTestLister{info}, nil
}

func (h editorTestHandler) Readlink(name string) (string, error) {
	name = cleanEditorTestPath(name)
	if target, ok := h.readlinks[name]; ok {
		return target, nil
	}
	return os.Readlink(name)
}

func newEditorTestSFTPClient(t *testing.T) *sftp.Client {
	return newEditorTestSFTPClientWithHandler(t, editorTestHandler{})
}

func newEditorTestSFTPClientWithHandler(t *testing.T, handler editorTestHandler) *sftp.Client {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serverReady := make(chan net.Conn, 1)
	serverErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		serverReady <- conn
	}()
	clientConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	var serverConn net.Conn
	select {
	case serverConn = <-serverReady:
	case err = <-serverErr:
		_ = clientConn.Close()
		_ = listener.Close()
		t.Fatal(err)
	}
	_ = listener.Close()
	server := sftp.NewRequestServer(serverConn, sftp.Handlers{
		FileGet:  handler,
		FilePut:  handler,
		FileCmd:  handler,
		FileList: handler,
	})
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve() }()
	client, err := sftp.NewClientPipe(clientConn, clientConn)
	if err != nil {
		_ = server.Close()
		_ = clientConn.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
		_ = clientConn.Close()
		_ = serverConn.Close()
		select {
		case <-serveDone:
		case <-time.After(2 * time.Second):
			t.Error("test SFTP server did not stop")
		}
	})
	return client
}

func TestRemoteTarArchiveCommandQuotesPathsAndChecksTar(t *testing.T) {
	sourcePath := "/srv/it's data/project"
	archivePath := "/tmp/web ssh archive.tar.gz"
	command := remoteTarArchiveCommand(sourcePath, archivePath)
	if !strings.Contains(command, "command -v tar") {
		t.Fatalf("archive command does not check tar availability: %q", command)
	}
	if !strings.Contains(command, "tar -czf "+shellQuote(archivePath)) {
		t.Fatalf("archive path is not safely quoted: %q", command)
	}
	if !strings.Contains(command, "-C "+shellQuote(pathpkg.Dir(sourcePath))+" -- "+shellQuote(pathpkg.Base(sourcePath))) {
		t.Fatalf("source path is not safely split and quoted: %q", command)
	}
}

func TestLegacySFTPArchiveRespectsEntryLimit(t *testing.T) {
	t.Setenv("WEBSSH_FOLDER_ARCHIVE_MAX_ENTRIES", "2")
	client := newEditorTestSFTPClient(t)
	localDir := t.TempDir()
	sourceLocal := filepath.Join(localDir, "source")
	if err := os.Mkdir(sourceLocal, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceLocal, "one.txt"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceLocal, "two.txt"), []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	archivePath, err := reserveRemoteFolderArchive(client, editorTestRemotePath(localDir))
	if err != nil {
		t.Fatal(err)
	}
	defer removeRemoteFolderArchive(client, archivePath)
	err = writeRemoteDirectoryArchiveViaSFTP(context.Background(), client, editorTestRemotePath(sourceLocal), archivePath)
	if err == nil || !strings.Contains(err.Error(), "more than 2 entries") {
		t.Fatalf("legacy archive limit error = %v", err)
	}
}

func TestPrepareRemoteDirectoryArchiveCreatesAndRemovesTemporaryArchive(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	sourceLocalPath := dir + string(os.PathSeparator) + "配置 folder"
	if err := os.Mkdir(sourceLocalPath, 0o755); err != nil {
		t.Fatal(err)
	}
	sourcePath := editorTestRemotePath(sourceLocalPath)
	payload := []byte("fake tar gzip payload")
	var archivedSource string
	archivePath, info, err := prepareRemoteDirectoryArchive(context.Background(), client, sourcePath, func(_ context.Context, source, archive string) error {
		archivedSource = source
		file, openErr := client.OpenFile(archive, os.O_WRONLY|os.O_TRUNC)
		if openErr != nil {
			return openErr
		}
		if _, writeErr := file.Write(payload); writeErr != nil {
			_ = file.Close()
			return writeErr
		}
		return file.Close()
	})
	if err != nil {
		t.Fatalf("prepareRemoteDirectoryArchive() error = %v", err)
	}
	if archivedSource != sourcePath {
		t.Fatalf("archived source = %q, want %q", archivedSource, sourcePath)
	}
	if info.Size() != int64(len(payload)) {
		t.Fatalf("archive size = %d, want %d", info.Size(), len(payload))
	}
	archiveName := pathpkg.Base(archivePath)
	if !strings.HasPrefix(archiveName, remoteFolderArchivePrefix) || !strings.HasSuffix(archiveName, remoteFolderArchiveSuffix) {
		t.Fatalf("unexpected archive name %q", archiveName)
	}
	content, err := os.ReadFile(cleanEditorTestPath(archivePath))
	if err != nil || string(content) != string(payload) {
		t.Fatalf("archive content = %q, error = %v", content, err)
	}
	if err := removeRemoteFolderArchive(client, archivePath); err != nil {
		t.Fatalf("removeRemoteFolderArchive() error = %v", err)
	}
	if _, err := os.Lstat(cleanEditorTestPath(archivePath)); !os.IsNotExist(err) {
		t.Fatalf("temporary archive still exists or returned unexpected error: %v", err)
	}
}

func TestPrepareRemoteDirectoryArchiveRemovesFailedTemporaryFiles(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	sourceLocalPath := dir + string(os.PathSeparator) + "folder"
	if err := os.Mkdir(sourceLocalPath, 0o755); err != nil {
		t.Fatal(err)
	}
	_, _, err := prepareRemoteDirectoryArchive(context.Background(), client, editorTestRemotePath(sourceLocalPath), func(_ context.Context, _, archive string) error {
		file, openErr := client.OpenFile(archive, os.O_WRONLY|os.O_TRUNC)
		if openErr == nil {
			_, _ = file.Write([]byte("partial archive"))
			_ = file.Close()
		}
		return errors.New("tar failed")
	})
	if err == nil || !strings.Contains(err.Error(), "tar failed") {
		t.Fatalf("archive failure = %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), remoteFolderArchivePrefix) {
			t.Fatalf("failed temporary archive was not removed: %s", entry.Name())
		}
	}
}

func TestWriteRemoteDirectoryArchiveViaSFTPIncludesNestedFiles(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	sourceLocalPath := dir + string(os.PathSeparator) + "project"
	nestedLocalPath := sourceLocalPath + string(os.PathSeparator) + "nested"
	if err := os.MkdirAll(nestedLocalPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceLocalPath+string(os.PathSeparator)+"README.txt", []byte("hello archive\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedLocalPath+string(os.PathSeparator)+"配置.ini", []byte("enabled=true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archivePath, err := reserveRemoteFolderArchive(client, editorTestRemotePath(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer removeRemoteFolderArchive(client, archivePath)
	if err := writeRemoteDirectoryArchiveViaSFTP(context.Background(), client, editorTestRemotePath(sourceLocalPath), archivePath); err != nil {
		t.Fatalf("writeRemoteDirectoryArchiveViaSFTP() error = %v", err)
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
	contents := make(map[string]string)
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
		contents[header.Name] = string(content)
	}
	if contents["project/README.txt"] != "hello archive\n" {
		t.Fatalf("README archive content = %q", contents["project/README.txt"])
	}
	if contents["project/nested/配置.ini"] != "enabled=true\n" {
		t.Fatalf("nested archive content = %q", contents["project/nested/配置.ini"])
	}
}

func TestDownloadRemoteDirectoryArchiveStreamsAndRemovesTemporaryArchive(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	sourceLocalPath := dir + string(os.PathSeparator) + "download me"
	if err := os.MkdirAll(sourceLocalPath+string(os.PathSeparator)+"nested", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceLocalPath+string(os.PathSeparator)+"nested"+string(os.PathSeparator)+"内容.txt", []byte("streamed archive\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	remotePath := editorTestRemotePath(sourceLocalPath)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/download", nil)
	sshClient := core.SSHClient{Sftp: client}
	responseBody := ResponseBody{Msg: "success"}

	downloadRemoteDirectoryArchive(ctx, &sshClient, remotePath, remotePath, &responseBody)

	if recorder.Code != http.StatusOK {
		t.Fatalf("download status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("X-WebSSH-Download-Kind"); got != "directory-archive" {
		t.Fatalf("download kind = %q", got)
	}
	if got := recorder.Header().Get("Content-Disposition"); !strings.Contains(got, "download%20me.tar.gz") && !strings.Contains(got, "download me.tar.gz") {
		t.Fatalf("content disposition = %q", got)
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	found := false
	for {
		header, nextErr := tarReader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		if header.Name != "download me/nested/内容.txt" {
			continue
		}
		content, readErr := io.ReadAll(tarReader)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if string(content) != "streamed archive\n" {
			t.Fatalf("archived content = %q", content)
		}
		found = true
	}
	if !found {
		t.Fatal("downloaded archive did not contain the nested file")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), remoteFolderArchivePrefix) {
			t.Fatalf("temporary archive remained after streaming: %s", entry.Name())
		}
	}
}

func TestRemoteFolderArchiveRejectsRootAndUnrelatedCleanupPaths(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	if _, _, err := prepareRemoteDirectoryArchive(context.Background(), client, "/", func(context.Context, string, string) error { return nil }); err == nil || !strings.Contains(err.Error(), "root directory") {
		t.Fatalf("root archive error = %v", err)
	}
	if err := removeRemoteFolderArchive(client, "/tmp/unrelated.tar.gz"); err == nil || !strings.Contains(err.Error(), "invalid temporary archive path") {
		t.Fatalf("unrelated cleanup error = %v", err)
	}
	if !isRemoteFolderArchiveName(".webssh-folder-0123456789abcdef01234567.tar.gz") {
		t.Fatal("valid temporary archive name was rejected")
	}
	if isRemoteFolderArchiveName(".webssh-folder-not-random.tar.gz") {
		t.Fatal("unrelated similarly named file was treated as a temporary archive")
	}
	if got := remoteFolderArchiveDownloadName("/srv/资料"); got != "资料.tar.gz" {
		t.Fatalf("archive download name = %q", got)
	}
	if !remotePathWithin("/tmp/.webssh-folder-test.tar.gz", "/tmp") {
		t.Fatal("archive inside the source folder was not detected")
	}
	if remotePathWithin("/tmp2/.webssh-folder-test.tar.gz", "/tmp") {
		t.Fatal("sibling path was incorrectly treated as inside the source folder")
	}
}

func TestRemoteEditorReadWriteRoundTripAndConflict(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	localPath := dir + string(os.PathSeparator) + "配置.txt"
	path := editorTestRemotePath(localPath)
	original := "第一行\nsecond line\n"
	if err := os.WriteFile(localPath, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}

	opened, err := readRemoteTextFile(client, path, defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatalf("readRemoteTextFile() error = %v", err)
	}
	if opened.Content != original || opened.Version == "" || opened.TargetPath != path {
		t.Fatalf("unexpected opened snapshot: %#v", opened)
	}

	savedContent := "已在线保存\nwith UTF-8 ✓\n"
	saved, err := writeRemoteTextFile(client, path, []byte(savedContent), opened.Version, defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatalf("writeRemoteTextFile() error = %v", err)
	}
	if saved.Content != savedContent || saved.Version == opened.Version {
		t.Fatalf("unexpected saved snapshot: %#v", saved)
	}
	onDisk, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != savedContent {
		t.Fatalf("saved file = %q, want %q", onDisk, savedContent)
	}
	if info, statErr := os.Stat(localPath); statErr != nil {
		t.Fatal(statErr)
	} else if info.Mode().Perm() != opened.Mode.Perm() {
		t.Fatalf("saved mode = %04o, want opened SFTP mode %04o", info.Mode().Perm(), opened.Mode.Perm())
	}

	if err := os.WriteFile(localPath, []byte("changed elsewhere\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := writeRemoteTextFile(client, path, []byte("must not overwrite\n"), saved.Version, defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "remote file changed") {
		t.Fatalf("conflict save error = %v", err)
	}
	onDisk, err = os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "changed elsewhere\n" {
		t.Fatalf("conflict overwrote remote file: %q", onDisk)
	}
}

func TestRemoteEditorCreateFileAndRejectExistingTarget(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	localPath := dir + string(os.PathSeparator) + "新建脚本.sh"
	path := editorTestRemotePath(localPath)
	content := "#!/bin/sh\necho 'created online'\n"

	created, err := createRemoteTextFile(client, path, []byte(content), defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatalf("createRemoteTextFile() error = %v", err)
	}
	if created.Content != content || created.Version == "" {
		t.Fatalf("unexpected created snapshot: %#v", created)
	}
	onDisk, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != content {
		t.Fatalf("created file = %q, want %q", onDisk, content)
	}
	updated := content + "echo 'updated'\n"
	if _, err := writeRemoteTextFile(client, path, []byte(updated), created.Version, defaultRemoteEditorMaxBytes); err != nil {
		t.Fatalf("first save after create used an unstable version: %v", err)
	}
	if _, err := createRemoteTextFile(client, path, []byte("must not overwrite\n"), defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate create error = %v", err)
	}
	onDisk, err = os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != updated {
		t.Fatalf("duplicate create overwrote file: %q", onDisk)
	}
}

func TestRemoteEditorCreateRemovesPartialFileAfterWriteFailure(t *testing.T) {
	client := newEditorTestSFTPClientWithHandler(t, editorTestHandler{failWrites: true})
	localPath := filepath.Join(t.TempDir(), "partial.txt")
	path := editorTestRemotePath(localPath)
	if _, err := createRemoteTextFile(client, path, []byte("content that must not remain"), defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("createRemoteTextFile() error = %v", err)
	}
	if _, err := os.Lstat(localPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial file remained after failed create: %v", err)
	}
}

func TestDeleteRemoteFileRemovesFileAndRejectsDirectory(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	filePath := dir + string(os.PathSeparator) + "delete-me.txt"
	if err := os.WriteFile(filePath, []byte("delete me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := deleteRemoteFile(client, editorTestRemotePath(filePath)); err != nil {
		t.Fatalf("deleteRemoteFile() error = %v", err)
	}
	if _, err := os.Lstat(filePath); !os.IsNotExist(err) {
		t.Fatalf("deleted file still exists or returned unexpected error: %v", err)
	}
	if err := deleteRemoteFile(client, editorTestRemotePath(dir)); err == nil || !strings.Contains(err.Error(), "directories cannot be deleted") {
		t.Fatalf("directory delete error = %v", err)
	}
}

func TestDeleteRemoteFileRemovesSymlinkWithoutDeletingTarget(t *testing.T) {
	dir := t.TempDir()
	targetPath := dir + string(os.PathSeparator) + "target.txt"
	linkPath := dir + string(os.PathSeparator) + "target.link"
	if err := os.WriteFile(targetPath, []byte("keep target"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := newEditorTestSFTPClientWithHandler(t, editorTestHandler{readlinks: map[string]string{
		cleanEditorTestPath(editorTestRemotePath(linkPath)): targetPath,
	}})
	// The in-memory readlink mapping makes the SFTP server expose linkPath as a
	// symlink without requiring Windows symlink privileges. Create a harmless
	// filesystem entry at the same path so Remove has an exact link entry to
	// remove in this test handler.
	if err := os.WriteFile(linkPath, []byte("link placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := deleteRemoteFile(client, editorTestRemotePath(linkPath)); err != nil {
		t.Fatalf("deleteRemoteFile() symlink error = %v", err)
	}
	if _, err := os.Stat(targetPath); err != nil {
		t.Fatalf("symlink target was removed: %v", err)
	}
	if _, err := os.Lstat(linkPath); !os.IsNotExist(err) {
		t.Fatalf("symlink entry still exists or returned unexpected error: %v", err)
	}
}

func TestDeleteRemoteFileRejectsMissingAndRootPaths(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	if err := deleteRemoteFile(client, ""); err == nil || !strings.Contains(err.Error(), "missing path") {
		t.Fatalf("empty path error = %v", err)
	}
	if err := deleteRemoteFile(client, "/"); err == nil || !strings.Contains(err.Error(), "invalid file path") {
		t.Fatalf("root path error = %v", err)
	}
	missing := editorTestRemotePath(t.TempDir() + string(os.PathSeparator) + "missing.txt")
	if err := deleteRemoteFile(client, missing); err == nil || !strings.Contains(err.Error(), "file does not exist") {
		t.Fatalf("missing file delete error = %v", err)
	}
}

func TestRenameRemotePathRenamesFileAndDirectory(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	sshClient := core.NewSSHClient()
	sshClient.Hostname = "rename.test"
	sshClient.Username = "root"

	oldFileLocal := filepath.Join(dir, "old.txt")
	if err := os.WriteFile(oldFileLocal, []byte("rename content\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	oldFile := editorTestRemotePath(oldFileLocal)
	newFile, isDir, err := renameRemotePath(context.Background(), sshClient, client, oldFile, "new.txt")
	if err != nil {
		t.Fatalf("renameRemotePath() file error = %v", err)
	}
	if isDir || pathpkg.Base(newFile) != "new.txt" {
		t.Fatalf("renamed file result = path %q, isDir %v", newFile, isDir)
	}
	content, err := os.ReadFile(filepath.Join(dir, "new.txt"))
	if err != nil || string(content) != "rename content\n" {
		t.Fatalf("renamed file content = %q, error = %v", content, err)
	}
	if _, err := os.Lstat(oldFileLocal); !os.IsNotExist(err) {
		t.Fatalf("old file still exists or returned unexpected error: %v", err)
	}

	oldDirLocal := filepath.Join(dir, "old-folder")
	if err := os.MkdirAll(filepath.Join(oldDirLocal, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldDirLocal, "nested", "keep.txt"), []byte("nested\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	newDir, isDir, err := renameRemotePath(context.Background(), sshClient, client, editorTestRemotePath(oldDirLocal), "new-folder")
	if err != nil {
		t.Fatalf("renameRemotePath() directory error = %v", err)
	}
	if !isDir || pathpkg.Base(newDir) != "new-folder" {
		t.Fatalf("renamed directory result = path %q, isDir %v", newDir, isDir)
	}
	content, err = os.ReadFile(filepath.Join(dir, "new-folder", "nested", "keep.txt"))
	if err != nil || string(content) != "nested\n" {
		t.Fatalf("renamed directory content = %q, error = %v", content, err)
	}
}

func TestRenameRemotePathRejectsExistingTargetWithoutOverwrite(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	oldLocal := filepath.Join(dir, "source.txt")
	targetLocal := filepath.Join(dir, "target.txt")
	if err := os.WriteFile(oldLocal, []byte("source\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetLocal, []byte("target\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	sshClient := core.NewSSHClient()
	sshClient.Hostname = "rename.test"
	sshClient.Username = "root"
	if _, _, err := renameRemotePath(context.Background(), sshClient, client, editorTestRemotePath(oldLocal), "target.txt"); err == nil || !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("existing target rename error = %v", err)
	}
	if content, err := os.ReadFile(oldLocal); err != nil || string(content) != "source\n" {
		t.Fatalf("source changed after rejected rename: content=%q error=%v", content, err)
	}
	if content, err := os.ReadFile(targetLocal); err != nil || string(content) != "target\n" {
		t.Fatalf("target overwritten after rejected rename: content=%q error=%v", content, err)
	}
}

func TestRenameRemotePathPreservesDirectoryIntentForSymlink(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	targetLocal := filepath.Join(dir, "target-folder")
	if err := os.MkdirAll(targetLocal, 0o755); err != nil {
		t.Fatal(err)
	}
	linkLocal := filepath.Join(dir, "folder-link")
	if err := os.Symlink(targetLocal, linkLocal); err != nil {
		t.Skipf("directory symlink is unavailable on this platform: %v", err)
	}
	sshClient := core.NewSSHClient()
	sshClient.Hostname = "rename.test"
	sshClient.Username = "root"
	newPath, isDir, err := renameRemotePath(context.Background(), sshClient, client, editorTestRemotePath(linkLocal), "renamed-link")
	if err != nil {
		t.Fatalf("renameRemotePath() directory symlink error = %v", err)
	}
	if !isDir || pathpkg.Base(newPath) != "renamed-link" {
		t.Fatalf("renamed directory symlink result = path %q, isDir %v", newPath, isDir)
	}
	info, err := os.Lstat(filepath.Join(dir, "renamed-link"))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("renamed path is not the original symlink: info=%v error=%v", info, err)
	}
}

func TestValidateRemoteRenameNameRejectsUnsafeNames(t *testing.T) {
	for _, name := range []string{
		"",
		".",
		"..",
		"nested/name",
		`nested\name`,
		"line\nbreak",
		strings.Repeat("界", 86),
	} {
		if _, err := validateRemoteRenameName(name); err == nil {
			t.Fatalf("validateRemoteRenameName(%q) unexpectedly succeeded", name)
		}
	}
	if got, err := validateRemoteRenameName("配置文件.yaml"); err != nil || got != "配置文件.yaml" {
		t.Fatalf("valid Unicode name = %q, %v", got, err)
	}
}

func TestRemoteEditorConcurrentStaleSavesDoNotOverwrite(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	localPath := dir + string(os.PathSeparator) + "concurrent.txt"
	path := editorTestRemotePath(localPath)
	if err := os.WriteFile(localPath, []byte("opened\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	opened, err := readRemoteTextFile(client, path, defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	request := fileSaveRequest{Path: path, Version: opened.Version}
	contents := []string{"first writer\n", "second writer\n"}
	errors := make([]error, len(contents))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for index := range contents {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			localRequest := request
			localRequest.Content = contents[index]
			_, errors[index] = saveRemoteTextFileWithLock(context.Background(), "same-remote-file", client, localRequest, defaultRemoteEditorMaxBytes)
		}(index)
	}
	close(start)
	wg.Wait()
	successes := 0
	conflicts := 0
	for _, saveErr := range errors {
		if saveErr == nil {
			successes++
		} else if strings.Contains(saveErr.Error(), "remote file changed") {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent save error: %v", saveErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent saves: successes=%d conflicts=%d errors=%v", successes, conflicts, errors)
	}
	onDisk, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != contents[0] && string(onDisk) != contents[1] {
		t.Fatalf("unexpected final file content: %q", onDisk)
	}
}

func TestRemoteEditorTargetLockWaitCanBeCancelled(t *testing.T) {
	release, err := acquireRemoteEditorTarget(context.Background(), "cancel-test")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if secondRelease, lockErr := acquireRemoteEditorTarget(ctx, "cancel-test"); lockErr == nil {
		secondRelease()
		t.Fatal("cancelled lock wait unexpectedly succeeded")
	} else if !errors.Is(lockErr, context.DeadlineExceeded) {
		t.Fatalf("cancelled lock wait error = %v", lockErr)
	}
	release()
}

func TestRemoteEditorEditsSymlinkTargetAndRejectsRetarget(t *testing.T) {
	dir := t.TempDir()
	firstTargetPath := dir + string(os.PathSeparator) + "first.txt"
	secondTargetPath := dir + string(os.PathSeparator) + "second.txt"
	linkLocalPath := dir + string(os.PathSeparator) + "link.txt"
	linkPath := editorTestRemotePath(linkLocalPath)
	firstTarget := editorTestRemotePath(firstTargetPath)
	secondTarget := editorTestRemotePath(secondTargetPath)
	if err := os.WriteFile(firstTargetPath, []byte("first target\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondTargetPath, []byte("second target\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := editorTestHandler{readlinks: map[string]string{cleanEditorTestPath(linkPath): firstTarget}}
	client := newEditorTestSFTPClientWithHandler(t, handler)
	opened, err := readRemoteTextFile(client, linkPath, defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatalf("readRemoteTextFile() symlink error = %v", err)
	}
	if opened.TargetPath != firstTarget || opened.Content != "first target\n" {
		t.Fatalf("unexpected symlink snapshot: %#v", opened)
	}
	saved, err := writeRemoteTextFileTarget(client, linkPath, []byte("edited through link\n"), opened.Version, opened.TargetPath, defaultRemoteEditorMaxBytes)
	if err != nil {
		t.Fatalf("writeRemoteTextFileTarget() symlink error = %v", err)
	}
	if saved.TargetPath != firstTarget {
		t.Fatalf("saved target = %q, want %q", saved.TargetPath, firstTarget)
	}
	if content, readErr := os.ReadFile(firstTargetPath); readErr != nil || string(content) != "edited through link\n" {
		t.Fatalf("symlink target content = %q, error = %v", content, readErr)
	}
	if _, exists := handler.readlinks[cleanEditorTestPath(linkPath)]; !exists {
		t.Fatal("editing removed the symbolic link")
	}

	handler.readlinks[cleanEditorTestPath(linkPath)] = secondTarget
	if _, err := writeRemoteTextFileTarget(client, linkPath, []byte("must not touch second\n"), saved.Version, firstTarget, defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "symbolic link target changed") {
		t.Fatalf("retargeted symlink save error = %v", err)
	}
	if content, readErr := os.ReadFile(secondTargetPath); readErr != nil || string(content) != "second target\n" {
		t.Fatalf("retargeted file was modified: content=%q error=%v", content, readErr)
	}
}

func TestRemoteSnapshotDataPreservesLinkAndResolvedTargetPaths(t *testing.T) {
	data := remoteSnapshotData("/etc/nginx/dujiao-next.conf", remoteFileSnapshot{
		Content:    "server {}\n",
		Version:    "version-1",
		TargetPath: "/etc/nginx/sites-available/dujiao-next.conf",
		Mode:       0o640,
		Modified:   time.Unix(123, 0),
	}, defaultRemoteEditorMaxBytes)
	if got := data["path"]; got != "/etc/nginx/dujiao-next.conf" {
		t.Fatalf("response path = %v", got)
	}
	if got := data["targetPath"]; got != "/etc/nginx/sites-available/dujiao-next.conf" {
		t.Fatalf("response targetPath = %v", got)
	}
	if got := data["isSymlink"]; got != true {
		t.Fatalf("response isSymlink = %v", got)
	}
}

func TestRemoteEditorRejectsBinaryFile(t *testing.T) {
	dir := t.TempDir()
	binaryLocalPath := dir + string(os.PathSeparator) + "binary.dat"
	binaryPath := editorTestRemotePath(binaryLocalPath)
	client := newEditorTestSFTPClient(t)
	if err := os.WriteFile(binaryLocalPath, []byte{'a', 0, 'b'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRemoteTextFile(client, binaryPath, defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "UTF-8 text") {
		t.Fatalf("binary read error = %v", err)
	}
}
