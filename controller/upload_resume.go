package controller

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

const uploadChunkBytes = 4 << 20

type resumeUploadRequest struct {
	SSHInfo     string `json:"sshInfo"`
	ID          string `json:"id"`
	Path        string `json:"path"`
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Fingerprint string `json:"fingerprint"`
	Action      string `json:"action"`
	Offset      int64  `json:"offset"`
	Hash        string `json:"hash"`
}

func validUploadDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

// Every request is bounded by one chunk, but has no read or lifetime deadline.
// The remote data survives HTTP/SSH disconnects and application restarts.
func ResumeUpload(c *gin.Context) *ResponseBody {
	response := &ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), response)
	release, ok := acquireUploadSlot(c)
	if !ok {
		response.Msg = "上传任务过多，请稍后重试"
		return response
	}
	defer release()
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, uploadChunkBytes+(1<<20))
	reader, err := c.Request.MultipartReader()
	if err != nil {
		response.Msg = "invalid multipart upload"
		return response
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "metadata" {
		response.Msg = "missing upload metadata"
		return response
	}
	metadata, err := io.ReadAll(io.LimitReader(part, uploadMetadataMaxBytes+1))
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	if len(metadata) > uploadMetadataMaxBytes {
		response.Msg = "upload metadata too large"
		return response
	}
	var request resumeUploadRequest
	decoder := json.NewDecoder(bytes.NewReader(metadata))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		response.Msg = "invalid upload metadata"
		return response
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF {
		response.Msg = "invalid upload metadata"
		return response
	}
	if request.Size < 0 || request.Size > uploadMaxBytes() {
		response.Msg = "file too large (maximum " + Bytefmt(uint64(uploadMaxBytes())) + ")"
		return response
	}
	if !validUploadDigest(request.Fingerprint) || !validUploadDigest(request.ID) {
		response.Msg = "invalid upload identity"
		return response
	}
	name, err := validateRemoteRenameName(request.Name)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	directory, err := validateUploadSubdirectory(request.Dir)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	if request.Path == "" || !path.IsAbs(request.Path) || strings.ContainsRune(request.Path, 0) {
		response.Msg = "invalid upload path"
		return response
	}
	if request.Action != "status" && request.Action != "chunk" && request.Action != "complete" && request.Action != "discard" {
		response.Msg = "invalid upload action"
		return response
	}
	var chunk []byte
	if request.Action == "chunk" {
		if request.Offset < 0 || request.Offset%uploadChunkBytes != 0 || request.Offset >= request.Size || !validUploadDigest(request.Hash) {
			response.Msg = "invalid upload offset or hash"
			return response
		}
		part, err = reader.NextPart()
		if err != nil || part.FormName() != "file" {
			response.Msg = "missing upload chunk"
			return response
		}
		chunk, err = io.ReadAll(io.LimitReader(part, uploadChunkBytes+1))
		if err != nil {
			response.Msg = err.Error()
			return response
		}
		expected := min(int64(uploadChunkBytes), request.Size-request.Offset)
		if int64(len(chunk)) != expected {
			response.Msg = "invalid upload chunk length"
			return response
		}
		digest := sha256.Sum256(chunk)
		if hex.EncodeToString(digest[:]) != request.Hash {
			response.Msg = "invalid upload chunk checksum"
			return response
		}
	}
	if _, err = reader.NextPart(); err != io.EOF {
		response.Msg = "invalid trailing upload field"
		return response
	}
	releaseSSH, ok := acquireSSHSlot(c)
	if !ok {
		response.Msg = "SSH 连接任务过多，请稍后重试"
		return response
	}
	defer releaseSSH()
	decoded, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	// Use the authenticated browser scope, never a scope supplied in sshInfo.
	owner, err := requestTrustScope(c)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	if username, loggedIn := currentAccount(c); loggedIn {
		owner = "account:" + username
	}
	destination := path.Join(request.Path, directory, name)
	identity, _ := json.Marshal([]any{owner, request.ID, destination, request.Size, request.Fingerprint})
	digest := sha256.Sum256(identity)
	tempDir := path.Join(path.Dir(destination), ".webssh-resume-"+hex.EncodeToString(digest[:]))
	unlock, err := acquireRemoteEditorTarget(c.Request.Context(), remoteEditorTargetKey(decoded, tempDir))
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	defer unlock()
	lease, err := acquireSFTPSessionLease(c, "upload:"+request.ID, request.SSHInfo, decoded)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	defer func() { lease.Release(request.Action == "discard" || sftpSessionConnectionBroken(err)) }()
	var offset int64
	var completed bool
	offset, completed, err = resumeRemoteUpload(lease.Client.Sftp, request, destination, tempDir, chunk)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	response.Data = gin.H{"offset": offset, "completed": completed, "chunkSize": uploadChunkBytes, "maxBytes": uploadMaxBytes()}
	return response
}

func resumeRemoteUpload(client *sftp.Client, request resumeUploadRequest, destination, tempDir string, chunk []byte) (int64, bool, error) {
	dataPath, commitPath := path.Join(tempDir, "data"), path.Join(tempDir, "committing")
	hashesPath := path.Join(tempDir, "hashes")
	info, err := client.Lstat(tempDir)
	if os.IsNotExist(err) {
		if request.Action == "discard" {
			return 0, false, nil
		}
		if request.Action != "status" {
			return 0, false, fmt.Errorf("upload not found; request status first")
		}
		if err = client.MkdirAll(path.Dir(destination)); err != nil {
			return 0, false, err
		}
		if err = client.Mkdir(tempDir); err != nil {
			return 0, false, err
		}
		if err = client.Chmod(tempDir, 0700); err != nil {
			_ = client.RemoveDirectory(tempDir)
			return 0, false, err
		}
	} else if err != nil {
		return 0, false, err
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, false, fmt.Errorf("invalid upload temporary directory")
	}
	if request.Action == "discard" {
		for _, file := range []string{dataPath, commitPath, hashesPath} {
			if err = client.Remove(file); err != nil && !os.IsNotExist(err) {
				return 0, false, err
			}
		}
		return 0, false, client.RemoveDirectory(tempDir)
	}
	// A restart may have interrupted creation before permissions were applied.
	if err = client.Chmod(tempDir, 0700); err != nil {
		return 0, false, err
	}
	info, err = client.Lstat(dataPath)
	if os.IsNotExist(err) {
		if _, commitErr := client.Lstat(commitPath); commitErr == nil {
			// A lost response after rename must never overwrite the destination
			// again. The marker records the verified file's size and mtime.
			marker, openErr := client.Open(commitPath)
			if openErr != nil {
				return 0, false, openErr
			}
			var receipt struct {
				Size        int64
				Modified    int64
				Fingerprint string
			}
			verifyErr := json.NewDecoder(io.LimitReader(marker, 1024)).Decode(&receipt)
			_ = marker.Close()
			if verifyErr != nil {
				return 0, false, verifyErr
			}
			finished, verifyErr := client.Lstat(destination)
			if verifyErr != nil {
				return 0, false, verifyErr
			}
			if !finished.Mode().IsRegular() || finished.Size() != request.Size || receipt.Size != request.Size || receipt.Fingerprint != request.Fingerprint || finished.ModTime().Unix() != receipt.Modified {
				return 0, false, fmt.Errorf("completed upload destination changed")
			}
			return request.Size, true, nil
		} else if !os.IsNotExist(commitErr) {
			return 0, false, commitErr
		}
		file, createErr := client.OpenFile(dataPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
		if createErr != nil {
			return 0, false, createErr
		}
		if err = file.Chmod(0600); err != nil {
			_ = file.Close()
			_ = client.Remove(dataPath)
			return 0, false, err
		}
		if err = file.Close(); err != nil {
			return 0, false, err
		}
		info, err = client.Lstat(dataPath)
	}
	if err != nil {
		return 0, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > request.Size {
		return 0, false, fmt.Errorf("invalid upload temporary file")
	}
	if err = client.Chmod(dataPath, 0600); err != nil {
		return 0, false, err
	}
	// The journal is advanced only after a chunk is closed and read back.
	// Partial writes (including an interrupted final chunk) are retried.
	hashInfo, hashErr := client.Lstat(hashesPath)
	var hashBytes int64
	if hashErr == nil {
		if !hashInfo.Mode().IsRegular() || hashInfo.Size() > ((request.Size+uploadChunkBytes-1)/uploadChunkBytes)*32 {
			return 0, false, fmt.Errorf("invalid upload checksum journal")
		}
		hashBytes = hashInfo.Size()
	} else if !os.IsNotExist(hashErr) {
		return 0, false, hashErr
	}
	offset := min(request.Size, (hashBytes/32)*uploadChunkBytes)
	if info.Size() < offset {
		offset = info.Size() - info.Size()%uploadChunkBytes
	}
	if request.Action == "chunk" {
		if offset != request.Offset {
			return offset, false, fmt.Errorf("upload offset conflict; resume from server offset")
		}
		file, openErr := client.OpenFile(dataPath, os.O_WRONLY)
		if openErr != nil {
			return offset, false, openErr
		}
		if err = file.Truncate(offset); err == nil {
			_, err = file.WriteAt(chunk, offset)
		}
		closeErr := file.Close()
		if err != nil {
			return offset, false, err
		}
		if closeErr != nil {
			return offset, false, closeErr
		}
		written, openErr := client.Open(dataPath)
		if openErr != nil {
			return offset, false, openErr
		}
		check := make([]byte, len(chunk))
		_, err = written.ReadAt(check, offset)
		_ = written.Close()
		if err != nil {
			return offset, false, err
		}
		digest := sha256.Sum256(chunk)
		if sha256.Sum256(check) != digest {
			return offset, false, fmt.Errorf("upload checksum conflict after remote write")
		}
		journal, openErr := client.OpenFile(hashesPath, os.O_CREATE|os.O_WRONLY)
		if openErr != nil {
			return offset, false, openErr
		}
		journalOffset := (offset / uploadChunkBytes) * 32
		if err = journal.Truncate(journalOffset); err == nil {
			_, err = journal.WriteAt(digest[:], journalOffset)
		}
		closeErr = journal.Close()
		if err != nil {
			return offset, false, err
		}
		if closeErr != nil {
			return offset, false, closeErr
		}
		offset += int64(len(chunk))
	}
	if request.Action == "complete" {
		if offset != request.Size {
			return offset, false, fmt.Errorf("upload incomplete: offset conflict")
		}
		// Verify the ordered digest journal (at most 80 KiB for 10 GiB),
		// avoiding a single long request that reads the entire remote file.
		root := sha256.New()
		if request.Size > 0 {
			journal, openErr := client.Open(hashesPath)
			if openErr != nil {
				return offset, false, openErr
			}
			_, err = io.Copy(root, io.LimitReader(journal, ((request.Size+uploadChunkBytes-1)/uploadChunkBytes)*32+1))
			_ = journal.Close()
			if err != nil {
				return offset, false, err
			}
		}
		if info.Size() != request.Size || hex.EncodeToString(root.Sum(nil)) != request.Fingerprint {
			return offset, false, fmt.Errorf("upload checksum conflict; discard and upload again")
		}
		marker, markerErr := client.OpenFile(commitPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
		if markerErr != nil {
			return offset, false, markerErr
		}
		err = json.NewEncoder(marker).Encode(struct {
			Size        int64
			Modified    int64
			Fingerprint string
		}{request.Size, info.ModTime().Unix(), request.Fingerprint})
		if err != nil {
			_ = marker.Close()
			return offset, false, err
		}
		if err = marker.Close(); err != nil {
			return offset, false, err
		}
		if err = client.PosixRename(dataPath, destination); err != nil {
			err = client.Rename(dataPath, destination)
		}
		if err != nil {
			return offset, false, err
		}
		return offset, true, nil
	}
	return offset, false, nil
}
