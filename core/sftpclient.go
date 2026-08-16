package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	pathpkg "path"

	"github.com/pkg/sftp"
)

func (sclient *SSHClient) CreateSftp() error {
	err := sclient.GenerateClient()
	if err != nil {
		return err
	}
	client, err := sftp.NewClient(sclient.Client)
	if err != nil {
		sclient.Close()
		return err
	}
	sclient.Sftp = client
	return nil
}

func (sclient *SSHClient) Mkdirs(path string) error {
	if _, err := sclient.Sftp.Stat(path); os.IsNotExist(err) {
		return sclient.Sftp.MkdirAll(path)
	}
	return nil
}

func (sclient *SSHClient) Download(srcPath string) (*sftp.File, error) {
	return sclient.Sftp.Open(srcPath)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

func (sclient *SSHClient) Upload(ctx context.Context, file io.Reader, id, dstPath string) error {
	return sclient.UploadChecked(ctx, file, id, dstPath, nil)
}

// UploadChecked keeps the remote write in a private temporary file until the
// caller validates the rest of its protocol framing. This lets the HTTP
// multipart handler reject trailing/duplicate fields without committing a
// file and then returning an error that would encourage a duplicate retry.
func (sclient *SSHClient) UploadChecked(ctx context.Context, file io.Reader, id, dstPath string, beforeCommit func() error) error {
	dir := pathpkg.Dir(dstPath)
	randomBytes := make([]byte, 12)
	if _, err := rand.Read(randomBytes); err != nil {
		return fmt.Errorf("create upload temp name: %w", err)
	}
	tmpPath := pathpkg.Join(dir, ".webssh-upload-"+hex.EncodeToString(randomBytes)+".tmp")
	dstFile, err := sclient.Sftp.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = dstFile.Close()
		if !committed {
			_ = sclient.Sftp.Remove(tmpPath)
		}
	}()
	wc := &WriteCounter{Id: id}
	tracked := id != "" && len(id) <= 128
	if tracked {
		WcMu.Lock()
		if _, exists := WcMap[id]; exists {
			tracked = false
		} else {
			WcMap[id] = wc
		}
		WcMu.Unlock()
	}
	if tracked {
		defer func() {
			WcMu.Lock()
			if WcMap[id] == wc {
				delete(WcMap, id)
			}
			WcMu.Unlock()
		}()
	}
	if _, err = io.Copy(dstFile, io.TeeReader(contextReader{ctx: ctx, r: file}, wc)); err != nil {
		return err
	}
	if err := dstFile.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if beforeCommit != nil {
		if err := beforeCommit(); err != nil {
			return err
		}
	}
	if err := replaceSFTPFile(sclient.Sftp, tmpPath, dstPath); err != nil {
		return err
	}
	committed = true
	return nil
}

func replaceSFTPFile(client *sftp.Client, oldPath, newPath string) error {
	if err := client.PosixRename(oldPath, newPath); err == nil {
		return nil
	}
	return client.Rename(oldPath, newPath)
}
