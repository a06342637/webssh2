package controller

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

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

type editorTestHandler struct{}

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

func (editorTestHandler) Filewrite(request *sftp.Request) (io.WriterAt, error) {
	return editorTestHandler{}.OpenFile(request)
}

func (editorTestHandler) OpenFile(request *sftp.Request) (sftp.WriterAtReaderAt, error) {
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
	return os.OpenFile(cleanEditorTestPath(request.Filepath), openFlags, 0o644)
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

func (editorTestHandler) Lstat(request *sftp.Request) (sftp.ListerAt, error) {
	info, err := os.Lstat(cleanEditorTestPath(request.Filepath))
	if err != nil {
		return nil, err
	}
	return editorTestLister{info}, nil
}

func newEditorTestSFTPClient(t *testing.T) *sftp.Client {
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
		FileGet:  editorTestHandler{},
		FilePut:  editorTestHandler{},
		FileCmd:  editorTestHandler{},
		FileList: editorTestHandler{},
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
	if opened.Content != original || opened.Version == "" {
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

func TestRemoteEditorRejectsSymlinkAndBinaryFile(t *testing.T) {
	client := newEditorTestSFTPClient(t)
	dir := t.TempDir()
	textLocalPath := dir + string(os.PathSeparator) + "text.txt"
	linkLocalPath := dir + string(os.PathSeparator) + "link.txt"
	binaryLocalPath := dir + string(os.PathSeparator) + "binary.dat"
	linkPath := editorTestRemotePath(linkLocalPath)
	binaryPath := editorTestRemotePath(binaryLocalPath)
	if err := os.WriteFile(textLocalPath, []byte("text"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(textLocalPath, linkLocalPath); err == nil {
		if _, readErr := readRemoteTextFile(client, linkPath, defaultRemoteEditorMaxBytes); readErr == nil || !strings.Contains(readErr.Error(), "symbolic links") {
			t.Fatalf("symlink read error = %v", readErr)
		}
	}
	if err := os.WriteFile(binaryLocalPath, []byte{'a', 0, 'b'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRemoteTextFile(client, binaryPath, defaultRemoteEditorMaxBytes); err == nil || !strings.Contains(err.Error(), "UTF-8 text") {
		t.Fatalf("binary read error = %v", err)
	}
}
