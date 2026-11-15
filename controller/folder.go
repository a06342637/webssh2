package controller

import (
	"context"
	"fmt"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

type folderRequest struct {
	SSHInfo    string `json:"sshInfo"`
	Path       string `json:"path"`
	Name       string `json:"name,omitempty"`
	Confirmed  bool   `json:"confirmed,omitempty"`
	ExistingOK bool   `json:"existingOK,omitempty"`
}

func CreateFolder(c *gin.Context) *ResponseBody { return changeFolder(c, false) }
func DeleteFolder(c *gin.Context) *ResponseBody { return changeFolder(c, true) }

func changeFolder(c *gin.Context, remove bool) *ResponseBody {
	response := &ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), response)
	var request folderRequest
	if err := bindStrictJSON(c, &request); err != nil {
		response.Msg = "invalid request: " + err.Error()
		return response
	}
	if request.Path == "" || !path.IsAbs(request.Path) || strings.ContainsRune(request.Path, 0) {
		response.Msg = "invalid folder path"
		return response
	}
	if remove && (!request.Confirmed || path.Clean(request.Path) == "/") {
		response.Msg = "invalid folder deletion confirmation or root path"
		return response
	}
	target := path.Clean(request.Path)
	if !remove {
		name, err := validateRemoteRenameName(request.Name)
		if err != nil {
			response.Msg = err.Error()
			return response
		}
		target = path.Join(target, name)
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		response.Msg = "SSH 连接任务过多，请稍后重试"
		return response
	}
	defer release()
	client, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	if err = createFileSFTPClient(c.Request.Context(), &client); err != nil {
		response.Msg = err.Error()
		return response
	}
	defer client.Close()
	stop := closeSSHOnContextDone(c.Request.Context(), &client)
	defer stop()
	unlock, err := acquireRemoteEditorTarget(c.Request.Context(), remoteEditorTargetKey(client, target))
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	defer unlock()
	if remove {
		info, statErr := client.Sftp.Lstat(target)
		if statErr != nil {
			err = statErr
		} else if info.Mode()&os.ModeSymlink != 0 {
			err = client.Sftp.Remove(target)
		} else if !info.IsDir() {
			err = fmt.Errorf("invalid folder type; refresh directory")
		} else {
			remaining := 500000
			err = removeRemoteTree(c.Request.Context(), client.Sftp, target, 0, &remaining)
		}
	} else {
		if info, statErr := client.Sftp.Lstat(target); statErr == nil {
			if !request.ExistingOK || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				err = fmt.Errorf("folder already exists")
			}
		} else if !os.IsNotExist(statErr) {
			err = statErr
		} else {
			err = client.Sftp.Mkdir(target)
		}
	}
	if err != nil {
		response.Msg = err.Error()
		return response
	}
	response.Data = gin.H{"path": target, "name": path.Base(target)}
	return response
}

// Lstat each entry: links are removed, never traversed. Cancellation stops a
// large deletion; any already-removed entries remain removed.
func removeRemoteTree(ctx context.Context, client *sftp.Client, target string, depth int, remaining *int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if path.Clean(target) == "/" || !path.IsAbs(target) {
		return fmt.Errorf("invalid folder deletion path")
	}
	if depth > 128 || *remaining <= 0 {
		return fmt.Errorf("folder exceeds deletion traversal limit")
	}
	*remaining--
	info, err := client.Lstat(target)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return client.Remove(target)
	}
	entries, err := client.ReadDir(target)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name, err := validateRemoteRenameName(entry.Name())
		if err != nil {
			return err
		}
		// Recheck the parent before descending so an ordinary rename to a
		// symlink during traversal cannot redirect deletion outside the tree.
		parent, err := client.Lstat(target)
		if err != nil {
			return err
		}
		if !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("folder changed during deletion")
		}
		if err := removeRemoteTree(ctx, client, path.Join(target, name), depth+1, remaining); err != nil {
			return err
		}
	}
	return client.RemoveDirectory(target)
}
