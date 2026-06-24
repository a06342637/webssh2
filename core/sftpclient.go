package core

import (
	"io"
	"mime/multipart"
	"os"

	"github.com/pkg/sftp"
)

func (sclient *SSHClient) CreateSftp() error {
	err := sclient.GenerateClient()
	if err != nil {
		return err
	}
	client, err := sftp.NewClient(sclient.Client)
	if err != nil {
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

func (sclient *SSHClient) Upload(file multipart.File, id, dstPath string) error {
	dstFile, err := sclient.Sftp.Create(dstPath)
	if err != nil {
		return err
	}
	defer dstFile.Close()
	wc := &WriteCounter{Id: id}
	WcMu.Lock()
	WcList = append(WcList, wc)
	WcMu.Unlock()
	defer func() {
		WcMu.Lock()
		defer WcMu.Unlock()
		if len(WcList) < 2 {
			WcList = nil
		} else {
			for i := 0; i < len(WcList); i++ {
				if WcList[i].Id == id {
					WcList = append(WcList[:i], WcList[i+1:]...)
					break
				}
			}
		}
	}()
	_, err = io.Copy(dstFile, io.TeeReader(file, wc))
	return err
}
