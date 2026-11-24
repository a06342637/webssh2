package controller

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

// The library's in-memory handler rejects chmod on directories. Model this
// supported server operation while retaining its real SFTP reads and writes.
type resumeTestFileCmd struct{ sftp.FileCmder }

func (h resumeTestFileCmd) Filecmd(r *sftp.Request) error {
	if r.Method == "Setstat" && r.AttrFlags().Permissions && !r.AttrFlags().Size {
		return nil
	}
	return h.FileCmder.Filecmd(r)
}
func (h resumeTestFileCmd) PosixRename(r *sftp.Request) error {
	return h.FileCmder.(sftp.PosixRenameFileCmder).PosixRename(r)
}
func resumeTestHandlers() sftp.Handlers {
	h := sftp.InMemHandler()
	h.FileCmd = resumeTestFileCmd{h.FileCmd}
	return h
}

func resumeTestFingerprint(content []byte) string {
	root := sha256.New()
	for offset := 0; offset < len(content); offset += uploadChunkBytes {
		digest := sha256.Sum256(content[offset:min(len(content), offset+uploadChunkBytes)])
		_, _ = root.Write(digest[:])
	}
	return hex.EncodeToString(root.Sum(nil))
}

func resumeTestRequest(t *testing.T, request resumeUploadRequest, chunk []byte, owner string) *ResponseBody {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	metadata, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.WriteField("metadata", string(metadata)); err != nil {
		t.Fatal(err)
	}
	if chunk != nil {
		part, err := writer.CreateFormFile("file", request.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/file/upload/resume", &body)
	ctx.Request.Header.Set("Content-Type", writer.FormDataContentType())
	ctx.Set(trustScopeContextKey, owner)
	return ResumeUpload(ctx)
}

func TestResumeUploadReconnectIntegrityAndCommit(t *testing.T) {
	t.Setenv("WEBSSH_UPLOAD_VERIFY_REMOTE", "true")
	gin.SetMode(gin.TestMode)
	handlers := resumeTestHandlers()
	installMemorySFTPFileFactories(t, handlers)
	client, _ := newMemorySFTPTestClient(t, handlers)
	content := append(bytes.Repeat([]byte{37}, uploadChunkBytes), []byte("final chunk")...)
	request := resumeUploadRequest{SSHInfo: sftpSessionTestSSHInfo(t), ID: strings.Repeat("b", 64), Path: "/uploads", Dir: " folder /nested", Name: "large.bin", Size: int64(len(content)), Fingerprint: resumeTestFingerprint(content), Action: "status"}
	owner := strings.Repeat("a", 32)
	run := func(action string, offset int64, chunk []byte) gin.H {
		t.Helper()
		request.Action, request.Offset = action, offset
		if chunk != nil {
			digest := sha256.Sum256(chunk)
			request.Hash = hex.EncodeToString(digest[:])
		}
		response := resumeTestRequest(t, request, chunk, owner)
		if response.Msg != "success" {
			t.Fatalf("%s: %s", action, response.Msg)
		}
		return response.Data.(gin.H)
	}
	if got := run("status", 0, nil)["offset"]; got != int64(0) {
		t.Fatal(got)
	}
	destination := "/uploads/ folder /nested/large.bin"
	writeMemorySFTPTestFile(t, client, destination, "original")
	run("chunk", 0, content[:uploadChunkBytes])
	// Drop pooled transport: subsequent request must recover from remote state.
	resetSFTPSessionRegistryForTest()
	if got := run("status", 0, nil)["offset"]; got != int64(uploadChunkBytes) {
		t.Fatal(got)
	}
	if got := readMemorySFTPTestFile(t, client, destination); got != "original" {
		t.Fatal("partial upload replaced destination")
	}
	request.Action, request.Offset = "chunk", 0
	if response := resumeTestRequest(t, request, content[:uploadChunkBytes], owner); !strings.Contains(response.Msg, "offset conflict") {
		t.Fatal(response.Msg)
	}
	// Another browser with the same client ID cannot access this partial file.
	request.Action = "status"
	if response := resumeTestRequest(t, request, nil, strings.Repeat("c", 32)); response.Msg != "success" || response.Data.(gin.H)["offset"] != int64(0) {
		t.Fatalf("scope isolation: %+v", response)
	}
	run("chunk", uploadChunkBytes, content[uploadChunkBytes:])
	if run("complete", 0, nil)["completed"] != true {
		t.Fatal("not completed")
	}
	if got := readMemorySFTPTestFile(t, client, destination); got != string(content) {
		t.Fatal("content mismatch")
	}
	resetSFTPSessionRegistryForTest()
	if run("status", 0, nil)["completed"] != true {
		t.Fatal("lost final response not recovered")
	}
	run("discard", 0, nil)
	if got := readMemorySFTPTestFile(t, client, destination); got != string(content) {
		t.Fatal("discard removed committed destination")
	}
	resetSFTPSessionRegistryForTest()
}

func TestResumeUploadRejectsInvalidChunkAndTenGiBBoundary(t *testing.T) {
	t.Setenv("WEBSSH_UPLOAD_MAX_BYTES", "")
	if uploadMaxBytes() != 10<<30 {
		t.Fatal(uploadMaxBytes())
	}
	handlers := resumeTestHandlers()
	installMemorySFTPFileFactories(t, handlers)
	t.Cleanup(resetSFTPSessionRegistryForTest)
	request := resumeUploadRequest{SSHInfo: sftpSessionTestSSHInfo(t), ID: strings.Repeat("e", 64), Path: "/uploads", Name: "ten.bin", Size: 10 << 30, Fingerprint: strings.Repeat("f", 64), Action: "status"}
	owner := strings.Repeat("a", 32)
	if r := resumeTestRequest(t, request, nil, owner); r.Msg != "success" {
		t.Fatal(r.Msg)
	}
	request.Size++
	if r := resumeTestRequest(t, request, nil, owner); ResponseHTTPStatus(r) != http.StatusRequestEntityTooLarge {
		t.Fatal(r.Msg)
	}
	request.Size, request.Action, request.Hash = 4, "chunk", strings.Repeat("0", 64)
	if r := resumeTestRequest(t, request, []byte("test"), owner); !strings.Contains(r.Msg, "checksum") {
		t.Fatal(r.Msg)
	}
	request.Offset = 1
	if r := resumeTestRequest(t, request, []byte("test"), owner); !strings.Contains(r.Msg, "offset") {
		t.Fatal(r.Msg)
	}
	request.Action, request.Dir = "status", "../escape"
	if r := resumeTestRequest(t, request, nil, owner); !strings.Contains(r.Msg, "invalid upload directory") {
		t.Fatal(r.Msg)
	}
}

func TestResumeRemotePartialChunkAndChecksumFailure(t *testing.T) {
	client, _ := newMemorySFTPTestClient(t, resumeTestHandlers())
	content := bytes.Repeat([]byte{19}, uploadChunkBytes+13)
	request := resumeUploadRequest{Action: "status", Size: int64(len(content)), Fingerprint: resumeTestFingerprint(content)}
	dest, temp := "/uploads/file", "/uploads/.webssh-resume-test"
	if _, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil {
		t.Fatal(err)
	}
	writeMemorySFTPTestFile(t, client, temp+"/data", string(content[:uploadChunkBytes+3]))
	digest := sha256.Sum256(content[:uploadChunkBytes])
	writeMemorySFTPTestFile(t, client, temp+"/hashes", string(digest[:]))
	if offset, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil || offset != uploadChunkBytes {
		t.Fatalf("partial: %d %v", offset, err)
	}
	request.Action, request.Offset = "chunk", uploadChunkBytes
	if _, _, err := resumeRemoteUpload(client, request, dest, temp, content[uploadChunkBytes:]); err != nil {
		t.Fatal(err)
	}
	request.Action, request.Fingerprint = "complete", strings.Repeat("0", 64)
	if _, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err == nil {
		t.Fatal("checksum mismatch committed")
	}
	if _, err := client.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("destination exists after failed verification")
	}
}

func TestResumeUploadTenGiBOffsetsWithSparseFile(t *testing.T) {
	if os.Getenv("WEBSSH_TEST_LARGE_UPLOAD") != "1" {
		t.Skip("set WEBSSH_TEST_LARGE_UPLOAD=1 to exercise the 10 GiB file offset on disk")
	}
	client := newEditorTestSFTPClient(t)
	local := t.TempDir()
	dest := editorTestRemotePath(filepath.Join(local, "ten.bin"))
	tempLocal := filepath.Join(local, ".webssh-resume-large")
	temp := editorTestRemotePath(tempLocal)
	request := resumeUploadRequest{Action: "status", Size: 10 << 30}
	if _, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if output, err := exec.Command("fsutil", "sparse", "setflag", filepath.Join(tempLocal, "data")).CombinedOutput(); err != nil {
			t.Skipf("cannot create sparse test file: %s: %v", output, err)
		}
	}
	file, err := os.OpenFile(filepath.Join(tempLocal, "data"), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(request.Size - uploadChunkBytes); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	_ = file.Close()
	lastChunk := bytes.Repeat([]byte{23}, uploadChunkBytes)
	journal := bytes.Repeat(make([]byte, 32), int(request.Size/uploadChunkBytes)-1)
	if err = os.WriteFile(filepath.Join(tempLocal, "hashes"), journal, 0600); err != nil {
		t.Fatal(err)
	}
	lastDigest := sha256.Sum256(lastChunk)
	root := sha256.Sum256(append(journal, lastDigest[:]...))
	request.Fingerprint = hex.EncodeToString(root[:])
	if offset, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil || offset != request.Size-uploadChunkBytes {
		t.Fatalf("large offset %d %v", offset, err)
	}
	request.Action, request.Offset = "chunk", request.Size-uploadChunkBytes
	if offset, _, err := resumeRemoteUpload(client, request, dest, temp, lastChunk); err != nil || offset != request.Size {
		t.Fatalf("last chunk %d %v", offset, err)
	}
	request.Action = "complete"
	if _, completed, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil || !completed {
		t.Fatalf("commit %v %v", completed, err)
	}
	if info, err := os.Stat(filepath.Join(local, "ten.bin")); err != nil || info.Size() != 10<<30 {
		t.Fatalf("large file size: %v %v", info, err)
	}
}

func TestResumeRemoteEmptyFileAndInterruptedFinalJournal(t *testing.T) {
	client, _ := newMemorySFTPTestClient(t, resumeTestHandlers())
	for _, content := range [][]byte{nil, []byte("last chunk")} {
		request := resumeUploadRequest{Action: "status", Size: int64(len(content)), Fingerprint: resumeTestFingerprint(content)}
		dest, temp := "/uploads/empty-or-small", "/uploads/.webssh-resume-final"
		if _, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil {
			t.Fatal(err)
		}
		if len(content) > 0 {
			// A full-length data file is insufficient: an interrupted digest
			// journal must cause the final chunk to be resent.
			writeMemorySFTPTestFile(t, client, temp+"/data", string(content))
			writeMemorySFTPTestFile(t, client, temp+"/hashes", "partial")
			if offset, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil || offset != 0 {
				t.Fatalf("unconfirmed final chunk: %d %v", offset, err)
			}
			request.Action = "chunk"
			if _, _, err := resumeRemoteUpload(client, request, dest, temp, content); err != nil {
				t.Fatal(err)
			}
		}
		request.Action = "complete"
		if _, done, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil || !done {
			t.Fatalf("complete %v %v", done, err)
		}
		if got := readMemorySFTPTestFile(t, client, dest); got != string(content) {
			t.Fatal(got)
		}
		request.Action = "discard"
		if _, _, err := resumeRemoteUpload(client, request, dest, temp, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConcurrentUploadWriteFailureKeepsPreviousCheckpoint(t *testing.T) {
	local := t.TempDir()
	dest := editorTestRemotePath(filepath.Join(local, "file.bin"))
	temp := editorTestRemotePath(filepath.Join(local, ".webssh-resume"))
	chunk := bytes.Repeat([]byte{73}, uploadChunkBytes)
	request := resumeUploadRequest{Action: "status", Size: int64(len(chunk)), Fingerprint: resumeTestFingerprint(chunk)}
	failing := newEditorTestSFTPClientWithHandler(t, editorTestHandler{failWrites: true}, sftp.UseConcurrentWrites(true))
	if _, _, err := resumeRemoteUpload(failing, request, dest, temp, nil); err != nil {
		t.Fatal(err)
	}
	request.Action = "chunk"
	if _, _, err := resumeRemoteUpload(failing, request, dest, temp, chunk); err == nil {
		t.Fatal("forced concurrent write succeeded")
	}
	working := newEditorTestSFTPClientWithHandler(t, editorTestHandler{}, sftp.UseConcurrentWrites(true))
	request.Action = "status"
	if offset, _, err := resumeRemoteUpload(working, request, dest, temp, nil); err != nil || offset != 0 {
		t.Fatalf("failed write advanced checkpoint: %d %v", offset, err)
	}
	request.Action = "chunk"
	if _, _, err := resumeRemoteUpload(working, request, dest, temp, chunk); err != nil {
		t.Fatal(err)
	}
	request.Action = "complete"
	if _, complete, err := resumeRemoteUpload(working, request, dest, temp, nil); err != nil || !complete {
		t.Fatalf("retry commit: %v %v", complete, err)
	}
	actual, err := os.ReadFile(filepath.Join(local, "file.bin"))
	if err != nil || !bytes.Equal(actual, chunk) {
		t.Fatalf("retry file mismatch: %v", err)
	}
}

func TestUploadResumesAfterParentRenameWithOriginalIdentity(t *testing.T) {
	handlers := resumeTestHandlers()
	installMemorySFTPFileFactories(t, handlers)
	t.Cleanup(resetSFTPSessionRegistryForTest)
	client, _ := newMemorySFTPTestClient(t, handlers)
	content := append(bytes.Repeat([]byte{81}, uploadChunkBytes), []byte("tail")...)
	request := resumeUploadRequest{SSHInfo: sftpSessionTestSSHInfo(t), ID: strings.Repeat("c", 64), Path: "/uploads/old", Name: "file", Size: int64(len(content)), Fingerprint: resumeTestFingerprint(content), Action: "status"}
	owner := strings.Repeat("a", 32)
	run := func(chunk []byte) *ResponseBody {
		t.Helper()
		if chunk != nil {
			sum := sha256.Sum256(chunk)
			request.Hash = hex.EncodeToString(sum[:])
		}
		result := resumeTestRequest(t, request, chunk, owner)
		if result.Msg != "success" {
			t.Fatal(result.Msg)
		}
		return result
	}
	run(nil)
	request.Action = "chunk"
	run(content[:uploadChunkBytes])
	if err := client.Rename("/uploads/old", "/uploads/new"); err != nil {
		t.Fatal(err)
	}
	request.OriginPath, request.Path, request.Action = "/uploads/old/file", "/uploads/new", "status"
	if offset := run(nil).Data.(gin.H)["offset"]; offset != int64(uploadChunkBytes) {
		t.Fatal(offset)
	}
	request.Action, request.Offset = "chunk", uploadChunkBytes
	run(content[uploadChunkBytes:])
	request.Action = "complete"
	run(nil)
	if actual := readMemorySFTPTestFile(t, client, "/uploads/new/file"); actual != string(content) {
		t.Fatal("renamed upload content mismatch")
	}
	if _, err := client.Stat("/uploads/old"); !os.IsNotExist(err) {
		t.Fatal("old folder was recreated")
	}
}
